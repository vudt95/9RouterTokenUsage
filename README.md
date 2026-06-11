# 9Router Token Usage

Extension VSCode theo dõi usage của các provider 9Router ngay trên **status bar góc dưới phải**.

Luồng dữ liệu hiện tại:

1. Gọi danh sách providers từ `GET /api/providers?page=1&pageSize=20&accountStatus=all&sort=priority&isActive=true`.
2. Với từng provider trong `connections`, gọi `GET /api/usage/{id}`.
3. Popup/tooltip hiển thị toàn bộ providers và usage tương ứng.
4. Status bar chỉ hiển thị provider có `priority=1`.

## Tính năng

- Lấy toàn bộ providers đang active từ API 9Router.
- Tự truy vấn usage cho từng provider theo `id`.
- Status bar hiển thị provider `priority=1` với quota được chọn (`session` mặc định).
- Hover status bar để xem tóm tắt toàn bộ providers.
- Bấm status bar để mở popup chi tiết toàn bộ providers và quota `session` / `weekly`.
- Tự đổi màu cảnh báo khi quota còn thấp hoặc API báo limit reached.
- Lưu API key an toàn bằng VSCode SecretStorage.

## Cài đặt & chạy thử development

```powershell
npm install
npm run compile
```

Sau đó nhấn `F5` trong VSCode để mở cửa sổ Extension Development Host.

## Sử dụng

1. Mở Command Palette (`Ctrl+Shift+P`).
2. Chạy **AI Token Usage: Thiết lập API Key** và nhập API key dạng `sk-...`.
3. Extension sẽ gửi đồng thời:
   - `x-api-key: <key>`
   - `Authorization: Bearer <key>`
4. Status bar sẽ hiển thị usage của provider `priority=1`.
5. Bấm status bar để xem popup đầy đủ.

## Lệnh

| Lệnh | Mô tả |
| --- | --- |
| `AI Token Usage: Thiết lập API Key` | Nhập / thay đổi / xoá API key |
| `AI Token Usage: Làm mới` | Làm mới thủ công |
| `AI Token Usage: Xem chi tiết` | Mở popup chi tiết |

## Cấu hình

| Thiết lập | Mặc định | Mô tả |
| --- | --- | --- |
| `aiTokenUsage.apiBaseUrl` | `http://localhost:20128` | Base URL API 9Router |
| `aiTokenUsage.providersPath` | `/api/providers?page=1&pageSize=20&accountStatus=all&sort=priority&isActive=true` | Endpoint lấy danh sách providers |
| `aiTokenUsage.usagePathTemplate` | `/api/usage/{id}` | Endpoint lấy usage theo provider id |
| `aiTokenUsage.statusBarQuota` | `session` | Quota hiển thị trên status bar (`session` hoặc `weekly`) |
| `aiTokenUsage.refreshIntervalSeconds` | `60` | Chu kỳ tự làm mới, tối thiểu 10 giây |

## Response kỳ vọng

### Providers

```json
{
  "connections": [
    {
      "id": "601951d7-871b-44e3-a5e1-7fd9d2fd8ca5",
      "provider": "codex",
      "authType": "oauth",
      "name": "account@example.com",
      "email": "account@example.com",
      "priority": 1,
      "isActive": true,
      "testStatus": "active",
      "expiresAt": "2026-06-21T10:04:04.801Z",
      "providerSpecificData": {
        "chatgptPlanType": "plus"
      }
    }
  ]
}
```

### Usage

```json
{
  "plan": "plus",
  "limitReached": false,
  "reviewLimitReached": false,
  "quotas": {
    "session": {
      "used": 38,
      "total": 100,
      "remaining": 62,
      "resetAt": "2026-06-11T21:01:39.000Z",
      "unlimited": false
    },
    "weekly": {
      "used": 69,
      "total": 100,
      "remaining": 31,
      "resetAt": "2026-06-12T10:12:55.000Z",
      "unlimited": false
    }
  }
}
```

## Đóng gói `.vsix`

```powershell
npm install -g @vscode/vsce
vsce package
```
