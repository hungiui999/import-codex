# 9router – ChatGPT/Codex Bulk Importer

Công cụ tự động import hàng loạt **OAuth token của ChatGPT/Codex** (định dạng JSON do CLI codex / extension lưu lại) thẳng vào database của **9router** (`db.json`).

Không cần `npm install` – chỉ dùng Node core (Node ≥ 18, đã đi kèm với 9router).

> Khác với importer Kiro: **9router KHÔNG có HTTP API cho codex**, nên tool này ghi trực tiếp vào `%APPDATA%\9router\db.json`. Vì DB được nạp vào memory, 9router phải tắt trước khi ghi — dùng `--force-stop` để tự động xử lý.

---

## 1. Cách dùng nhanh

1. Bỏ một hoặc nhiều file JSON OAuth của ChatGPT/Codex vào thư mục `tokens\` (mỗi tài khoản 1 file).
2. **Nhấp đôi** `import.cmd` – xong.

Mặc định CLI sẽ **không** dừng 9router để tránh ghi đè. Nếu 9router đang chạy:

- Thêm cờ `--force-stop` (CLI) **hoặc**
- Mở GUI bằng `gui.cmd` và để mặc định bật ô "Tự động dừng & khởi động lại 9router".

Sau khi xong, mở dashboard 9router → các Account mới sẽ xuất hiện trong mục **Providers → Codex/ChatGPT**.

---

## 2. Định dạng file đầu vào

Một object JSON gồm tối thiểu `id_token`, `access_token`, `refresh_token`, có thể có thêm `email`, `account_id`, `expired`, `last_refresh`, `type`, …:

```json
{
  "id_token": "eyJ...",
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "account_id": "b346c65a-28e2-47e6-9c2f-0fb336ae7784",
  "last_refresh": "2026-05-22T20:53:26Z",
  "email": "you@example.com",
  "type": "codex",
  "expired": "2026-06-01T20:53:27Z"
}
```

Tool sẽ:

- Decode JWT từ `id_token` để lấy `email`, `chatgpt_account_id`, `chatgpt_plan_type` (không verify chữ ký – chỉ đọc claims).
- Fallback về `email` / `account_id` ở top-level nếu JWT không decode được.
- Dùng field `expired` làm `expiresAt`. Nếu thiếu, tính `last_refresh + 10 ngày`.
- Sinh `id` mới qua `crypto.randomUUID()`.
- Đặt `priority = max(priority hiện có của codex) + 1`.
- Bỏ qua entry trùng `email` (case-insensitive) hoặc trùng `accessToken` với entry codex đã có.

---

## 3. Tuỳ chọn nâng cao (CLI)

```text
node import.js [files|folders] [--list]
               [--force-stop] [--no-restart]
               [--db <path>] [--url <baseUrl>]
```

| Flag                | Ý nghĩa                                                                                | Mặc định                                  |
| ------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| (positional)        | Đường dẫn file `.json` hoặc thư mục chứa nhiều `.json`                                  | `./tokens`                                |
| `--list` / `--dry`  | Chỉ phân tích file và in preview, KHÔNG ghi DB                                          | off                                       |
| `--force-stop`      | Nếu 9router đang chạy: dừng → ghi DB → khởi động lại                                    | off (mặc định bảo thủ: refuse + exit 4)   |
| `--no-restart`      | Sau khi ghi DB **không** tự khởi động lại 9router                                       | off                                       |
| `--db <path>`       | Chỉ định file db.json                                                                   | `%APPDATA%\9router\db.json`               |
| `--url <baseUrl>`   | URL kiểm tra trạng thái 9router                                                         | `http://127.0.0.1:20128`                  |

### Ví dụ

```powershell
# 1) Dry-run – chỉ liệt kê các tài khoản parse được
node .\import.js --list

# 2) Import 1 file cụ thể (9router phải đang tắt, hoặc dùng --force-stop)
node .\import.js D:\codex\acc1.json --force-stop

# 3) Quét folder, dừng + restart 9router tự động
node .\import.js .\tokens --force-stop

# 4) Ghi vào db.json khác (test)
node .\import.js .\tokens --db D:\tmp\db.json --no-restart
```

---

## 4. GUI cục bộ

Nhấp đôi `gui.cmd`. Tool spawn 1 web server cục bộ trên `127.0.0.1` rồi mở trình duyệt:

- Kéo thả các file `.json` vào ô.
- Nhấn **Kiểm tra token** để xem trước (email / plan / hết hạn).
- Nhấn **Import vào 9router** để ghi vào `db.json`.
- Ô **"Tự động dừng & khởi động lại 9router"** mặc định bật → tương đương `--force-stop` ở CLI.
- Có thể đổi đường dẫn db.json hoặc URL 9router ở phía trên.

---

## 5. Mã thoát (exit code)

| Code | Ý nghĩa                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | Tất cả OK                                                          |
| 1    | Không có file đầu vào hợp lệ                                       |
| 3    | Hoàn tất nhưng có ≥ 1 file không parse được                        |
| 4    | 9router đang chạy và không có `--force-stop`                       |
| 99   | Lỗi không mong đợi                                                 |

---

## 6. Bên dưới capot

- **Phát hiện 9router**: `GET http://127.0.0.1:20128/` (hoặc `Get-NetTCPConnection -LocalPort 20128`).
- **Dừng 9router**: kill các tiến trình `node.exe` chứa `9router` trong command line + tiến trình giữ port 20128. Đợi tối đa 10 giây cho port giải phóng.
- **Backup**: copy `db.json` → `db.json.bak-<timestamp>` trước khi ghi.
- **Atomic write**: ghi vào `db.json.tmp` rồi `rename` thành `db.json` (giữ pretty-print 2 spaces).
- **Khởi động lại**: spawn `node "C:\Users\Admin\AppData\Roaming\npm\node_modules\9router\cli.js" --tray --skip-update` ở chế độ detached, sau đó poll `http://127.0.0.1:20128/` tối đa 30s.
- **Bảo mật log**: tool **không** in token đầy đủ ra console; chỉ hiển thị email + 8 ký tự cuối của refresh token.

DB sau khi cập nhật vẫn giữ nguyên các key khác (`providerNodes`, `proxyPools`, `modelAliases`, `mitmAlias`, `combos`, `apiKeys`, `settings`, `pricing`); chỉ bổ sung vào mảng `providerConnections` các entry `provider: "codex"`.
