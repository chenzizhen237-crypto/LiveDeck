use livedeck_core::platforms::huya::search::HuyaAnchorItem;

#[tauri::command]
pub async fn search_huya_anchors(
    keyword: String,
    page: Option<usize>,
) -> Result<Vec<HuyaAnchorItem>, String> {
    livedeck_core::platforms::huya::search::search_huya_anchors(keyword, page).await
}
