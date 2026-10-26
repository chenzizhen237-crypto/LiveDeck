//! Long-lived V8 isolates for the signing scripts.
//!
//! Upstream built a fresh `JsRuntime` (a new V8 isolate plus re-evaluating the
//! scripts) on every Douyu stream request and every Douyin danmaku connect, and
//! did it on a Tokio worker thread. Each worker here owns one runtime on its own
//! OS thread, runs its setup once, and takes jobs over a channel.

use deno_core::{v8, FastString, JsRuntime, RuntimeOptions};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut JsRuntime) + Send>;

pub struct JsWorker {
    jobs: mpsc::Sender<Job>,
}

impl JsWorker {
    /// Spawns the worker thread. `setup` runs on each fresh runtime before any job.
    pub fn spawn(name: &str, setup: fn(&mut JsRuntime) -> Result<(), String>) -> Self {
        let (jobs, rx) = mpsc::channel::<Job>();
        let thread_name = name.to_string();
        std::thread::Builder::new()
            .name(thread_name.clone())
            .spawn(move || {
                #[cfg(target_os = "linux")]
                {
                    static INIT: std::sync::Once = std::sync::Once::new();
                    INIT.call_once(|| JsRuntime::init_platform(None));
                }
                let mut runtime = new_runtime(&thread_name, setup);
                while let Ok(job) = rx.recv() {
                    // A panicking job may leave the isolate in a bad state; start over.
                    if catch_unwind(AssertUnwindSafe(|| job(&mut runtime))).is_err() {
                        log::error!("[{}] JS job panicked; recreating runtime", thread_name);
                        runtime = new_runtime(&thread_name, setup);
                    }
                }
            })
            .expect("failed to spawn JS worker thread");
        Self { jobs }
    }

    /// Runs `f` on the worker's runtime and waits for its result.
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut JsRuntime) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        self.jobs
            .send(Box::new(move |rt| {
                let _ = tx.send(f(rt));
            }))
            .map_err(|_| "JS worker has stopped".to_string())?;
        rx.await.map_err(|_| "JS worker dropped the job".to_string())?
    }
}

fn new_runtime(name: &str, setup: fn(&mut JsRuntime) -> Result<(), String>) -> JsRuntime {
    let mut runtime = JsRuntime::new(RuntimeOptions::default());
    if let Err(e) = setup(&mut runtime) {
        // Jobs will surface their own errors (e.g. "get_sign is not defined").
        log::error!("[{}] JS setup failed: {}", name, e);
    }
    runtime
}

/// Executes a script and returns its completion value.
pub fn exec(rt: &mut JsRuntime, name: &'static str, code: String) -> Result<v8::Global<v8::Value>, String> {
    rt.execute_script(name, FastString::from(code)).map_err(|e| e.to_string())
}

/// Executes a script whose completion value must be a string.
pub fn exec_string(rt: &mut JsRuntime, name: &'static str, code: String) -> Result<String, String> {
    let value = exec(rt, name, code)?;
    let scope = &mut rt.handle_scope();
    let local = v8::Local::new(scope, value);
    if local.is_string() {
        Ok(local.to_rust_string_lossy(scope))
    } else {
        Err(format!("{} did not return a string", name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(rt: &mut JsRuntime) -> Result<(), String> {
        exec(rt, "[setup]", "globalThis.calls = 0;".into()).map(|_| ())
    }

    #[test]
    fn runtime_and_its_state_are_reused_across_jobs() {
        let worker = JsWorker::spawn("js-test", setup);
        tauri::async_runtime::block_on(async {
            for expected in ["1", "2", "3"] {
                let got = worker
                    .run(|rt| exec_string(rt, "[t]", "String(++globalThis.calls)".into()))
                    .await
                    .unwrap();
                assert_eq!(got, expected);
            }
        });
    }

    #[test]
    fn errors_come_back_and_the_worker_keeps_going() {
        let worker = JsWorker::spawn("js-test-err", setup);
        tauri::async_runtime::block_on(async {
            assert!(worker.run(|rt| exec_string(rt, "[t]", "nope()".into())).await.is_err());
            assert!(worker.run(|rt| exec_string(rt, "[t]", "42".into())).await.is_err());
            assert_eq!(worker.run(|rt| exec_string(rt, "[t]", "'ok'".into())).await.unwrap(), "ok");
        });
    }
}
