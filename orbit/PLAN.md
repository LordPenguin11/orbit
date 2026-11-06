# Orbit step 1: project skill + progress board

Status: step 1 + hooks + store tách đôi + panel theo focus + UI chi tiết/sửa + pause agent bằng CLI --interrupt xong, kiểm chứng thật. Rebrand (t-5) dừng có chủ đích.

## Mục tiêu
1. Skill `orbit-project`: agent lập plan, docs, task theo template.
2. Plugin `orbit-projects`: panel sidebar hiện kanban task + agent nào đang làm gì.

## Nguyên tắc sync upstream
- Chỉ thêm file mới, không sửa file Orca có sẵn. Không bundle skill vào Orca (đăng ký bundled sửa 5 file hot: generator, manifest, digests, bundled-sources, CLI guides). Skill Orbit là skill chuẩn tự chứa, cài vào thư mục skill của agent.
- Giữ nguyên định danh nội bộ `orca` / `ORCA_*` / CLI. Rebrand là milestone riêng.
- Mọi thứ Orbit nằm trong `orbit/`.

## Quyết định
- Lưu trữ: `<repo gốc>/.orbit/{plans,docs,tasks}/*.md`. Repo gốc = checkout chính (cha của git common dir), mọi worktree dùng chung. Một task = một file nên hai agent sửa hai task không xung đột; ghi file bằng write tạm + rename.
- Có commit `.orbit/` hay không: để người dùng quyết, mặc định không ignore, không auto commit.
- Frontmatter task: `id, title, status, owner, workspace, depends, plan`.
- `status` ∈ `todo | doing | review | done | blocked`. Kanban là một cách hiển thị của 5 giá trị này.
- Liên kết agent ↔ task: agent nhận task thì ghi `owner` + `workspace` vào file (skill dạy bước "claim"). Panel ghép `workspace` với event `agent:read`.
- Plugin: `trusted-worker` + panel components. Capability: `workspace:read`, `agent:read`, `storage:own`. Worker dùng `node:fs` (đã xác minh: child process không giới hạn permission).
- Giới hạn đã biết: panel chỉ nằm sidebar, chưa có view kanban toàn khung. Chấp nhận ở step 1.

## Files
- `orbit/skills/orbit-project/SKILL.md` + `templates/{plan,doc,task}.md` + `scripts/orbit.mjs` (CLI: `init`, `task new|claim|status|list`)
- `orbit/lib/store.mjs` — parse/ghi frontmatter, tìm repo gốc, claim/đổi status. Dùng chung cho script skill và worker plugin (một nguồn logic).
- `orbit/lib/board.mjs` — gom task theo cột, tính tiến độ, ghép agent
- `orbit/plugin/orca-plugin.json`, `orbit/plugin/src/main.ts` (worker: quét `.orbit/`, nghe event), `orbit/plugin/src/panel.tsx` (kanban + agent)
- `orbit/install.sh` — symlink skill vào thư mục skill của agent
- Script agent gọi để claim/đổi status thay vì tự sửa YAML: ít lỗi hơn và ghi nguyên tử.

## Tasks
1. Skill `orbit-project`: SKILL.md + 3 template + `install.sh`. (làm trước vì script ở task 2 là phần skill gọi)
2. `lib/store.mjs` + `scripts/orbit.mjs` TDD.
3. `lib/board.mjs` TDD.
4. `plugin/main.ts`: quét + theo dõi `.orbit/`, ghép `agent:read` / `workspace:read`.
5. `plugin/panel.tsx` + `plugin check`/`shot` xem panel thật.

## Tests (tên)
- `orbit/lib/store.test.mjs` (node --test): parses_frontmatter, claim_sets_owner_and_workspace, concurrent_set_status_keeps_both, finds_primary_root_from_linked_worktree
- `orbit/lib/board.test.mjs`: groups_by_status, progress_counts_done_over_total, depends_unmet_marks_blocked

## Ngoài phạm vi step 1
Gantt/milestone, dependency graph, đồng bộ Jira/Linear, view toàn khung, rebrand Orbit.
