import { useState } from "react";
import { proxifyWith } from "../../lib/images";
import { useProxyBase } from "../../hooks/useProxyBase";

export function Avatar({ src, name, size }: { src: string | null | undefined; name: string; size: number }) {
  const base = useProxyBase();
  const [failed, setFailed] = useState(false);
  const url = proxifyWith(base, src);

  if (!url || failed) {
    return (
      <span
        className="grid place-items-center rounded-full bg-panel-3 text-xs font-bold text-text-2"
        style={{ width: size, height: size }}
      >
        {name.slice(0, 1) || "?"}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      className="rounded-full bg-panel-3 object-cover"
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
