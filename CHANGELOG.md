# Changelog

Tất cả thay đổi đáng chú ý của extension được ghi tại đây.

## [0.0.1] - 2026-06-10

### Added
- Hiển thị token usage trên status bar góc dưới phải (token còn lại + %).
- Tooltip chi tiết với thanh tiến trình màu liền mạch.
- Tự đổi màu cảnh báo khi token còn ít (vàng ≤15%, đỏ ≤5%).
- Tự động làm mới theo chu kỳ (mặc định 60 giây).
- Lưu API key an toàn bằng VSCode SecretStorage.
- Cấu hình linh hoạt: `apiBaseUrl`, `apiPath`, `apiKeyHeader`, `apiKeyPrefix`.
- Ánh xạ field JSON (`fieldMap`) hỗ trợ dot-path cho JSON lồng nhau.
- Các trường mở rộng: plan, token input/output, requests, chi phí, model, tổ chức, reset_at.
- `extraFields` cho phép hiển thị field tuỳ ý.
- `statusBarFormat` để chọn cách hiển thị trên status bar.
