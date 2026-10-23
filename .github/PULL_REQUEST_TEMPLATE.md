## Tóm tắt thay đổi (Summary)
- **Task ID trong kế hoạch**: (ví dụ: `SEC-001`, `ENG-001`, `CAT-001`)
- **Mục tiêu**:

## Bằng chứng kiểm chứng (NO EVIDENCE, NO DONE)
- [ ] `npm run typecheck` xanh (0 lỗi)
- [ ] `npm run i18n:check` xanh (56/56 keys x 9 ngôn ngữ)
- [ ] `npm run build` thành công
- [ ] `npm run test:tier1` xanh
- [ ] Các bài test chuyên biệt liên quan đã chạy và đính kèm kết quả bên dưới

## Kiểm tra bất biến kiến trúc (Invariants)
- [ ] Không làm hỏng định dạng Proof V4 bundle (`StandaloneVerifier.ts`)
- [ ] Không xóa/đổi tên bất kỳ lệnh nào trong 48 slash commands + aliases
- [ ] Không ảnh hưởng luồng xử lý tiếng Việt IME (`test-vietnamese-ime-input.ts`)
- [ ] Không chứa stub/điểm số giả (`test-anti-stub-and-fake-metrics.ts`)
