# SAMUCHAN Taobao UI v2

UI này đọc trực tiếp `data/taobao_orders.json` do `samuchan.py` tạo.

## Đặt thư mục
Khuyến nghị đặt thư mục UI như sau:

C:\Users\AD\Documents\samuchan\SamuchanTaobao_UI\

và file dữ liệu ở:

C:\Users\AD\Documents\samuchan\data\taobao_orders.json

Nếu vị trí khác, đặt biến môi trường `SAMUCHAN_DATA_FILE` trước khi chạy Vite.

## Chạy

```powershell
cd C:\Users\AD\Documents\samuchan\SamuchanTaobao_UI
npm install
npm run dev
```

Sau khi `python samuchan.py` chạy xong và ghi dữ liệu, bấm **Cập nhật Taobao** trên web để đọc lại JSON.

UI này chưa tự khởi chạy Playwright; nút cập nhật chỉ đọc dữ liệu mới nhất để tránh mở nhiều browser profile Taobao cùng lúc.
