# Kế hoạch làm việc 3 phòng – Khối CFO (tháng 10/2026)

Trang: https://levienlanhuongk84.github.io/khoi-cfo/CFO-ke-hoach-lam-viec-3-phong-thang-10-2026/

Dữ liệu lưu trong Google Sheet + Google Drive qua Apps Script (`Code.gs`).

## Cài máy chủ (làm 1 lần, ~5 phút)
1. Tạo một Google Sheet mới (tên gợi ý: "KH công việc HT – Dữ liệu").
2. Tiện ích mở rộng › Apps Script › xóa nội dung mặc định › dán toàn bộ `Code.gs` › Lưu.
3. Chọn hàm `capQuyen` › Chạy › cấp quyền Sheet và Drive.
4. Triển khai › Tùy chọn triển khai mới › Loại: Ứng dụng web › Thực thi với tư cách: Tôi › Người có quyền truy cập: Bất kỳ ai › Triển khai.
5. Sao chép URL kết thúc bằng `/exec`, mở trang, dán vào ô "Link Apps Script", rồi thiết lập mật khẩu quản trị ngay.
