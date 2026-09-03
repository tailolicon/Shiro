# Độ trưởng thành của connector Shiro (ChatGPT Developer mode)

Nguồn: phỏng vấn trực tiếp GPT-5.6 Sol (2026-09-01) qua relay, với toàn bộ bề mặt MCP
của Shiro làm đầu vào. GPT xếp 12 thiếu sót theo mức ảnh hưởng; trạng thái bên dưới.

## Đã làm (2026-09-01)

1. **Tool annotations + title** — `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`
   cho cả 7 tool (`harness_cancel` là destructive; profiles/sessions/status là read-only +
   idempotent; start/continue/respond mở open-world vì engine có web_fetch/search).
2. **outputSchema + structuredContent** — mọi tool khai schema đầu ra; kết quả trả cả
   `structuredContent` (máy đọc, được SDK validate) lẫn text JSON (tương thích cũ).
3. **Chuẩn hóa lỗi** — lỗi nghiệp vụ trả `isError:true` với shape ổn định
   `{error:{message,code,retryable}}`; chỉ lỗi protocol mới thành JSON-RPC error.
4. **Trần long-poll 30s** — `MAX_WAIT_MS` hạ 45s→30s theo khoảng chịu đựng per-call
   của ChatGPT (khuyến nghị wait_ms 10–20s); việc dài nằm server-side, client re-poll.
5. **Server title** — serverInfo mang `title:"Shiro"`.
6. *(fix nền tảng cùng ngày)* Định tuyến model request: khi một turn MCP đang chạy,
   adapter bỏ qua browser relay và trả mọi request về broker MCP (`operationProbe`).
7. **Binary artifact bridge** — tool `harness_get_artifact`: trả bytes thật của file
   trong project root (ảnh → MCP ImageContent, text → inline, binary khác → base64
   resource; trần 6MB, chặn path/symlink escape) hoặc của attachment nội bộ
   (`attachments.readImage`). Block `image` trong model_requests giờ thành marker
   `image_attachment` kèm hướng dẫn fetch — không nhét base64 vào JSON kết quả.

## Đã làm (2026-09-02) — parity về hạt action

8. **Direct actions: 12 → 74 action.** Bài học từ connector GitHub (89 action) không
   phải là copy API GitHub, mà là *đóng gói thao tác thường dùng thành action tường minh
   thay vì đẩy hết qua một agent loop*. Shiro nay có 62 direct action mới, chia họ
   `bridge` / `filesystem` / `process` / `git` / `task` / `harness` / `fleet` / `browser`
   / `artifact` / `config`. Toàn bộ 12 action cũ giữ nguyên hợp đồng.
9. **Deterministic theo thiết kế.** Không direct action nào gọi LLM hay tạo durable
   session — có test khẳng định điều đó bằng một controller double sẽ ném lỗi nếu
   `start`/`submit`/`respond` bị chạm tới, và bằng việc kiểm tra broker không có
   model request nào được enqueue.
10. **Một lớp sandbox duy nhất** (`bridge/src/sandbox.js`) cho mọi action: path tương
    đối bắt buộc, chặn `..`/path tuyệt đối, và chặn symlink chain ra ngoài root *sau khi*
    resolve; path chưa tồn tại kiểm qua realpath của tổ tiên gần nhất.
11. **Phê duyệt cho thao tác phá hủy/ra mạng.** `confirm: true` bắt buộc cho
    `fs_delete` (recursive), overwrite của `fs_move`/`fs_copy`, `artifact_delete`,
    `git_restore`, `git_reset --hard`, `git_rebase`, `git_pull --rebase`, `git_push`.
    Không có `confirm` thì **không làm gì** và trả `PERMISSION_REQUIRED` kèm mô tả chính xác.
12. **Chuẩn hóa mã lỗi** thành tập cố định (`NOT_FOUND`, `CONFLICT`, `OUTSIDE_SANDBOX`,
    `PERMISSION_REQUIRED`, `GIT_CONFLICT`, …) thay vì `harness_error` cho mọi thứ.
13. **Feature detection**: `bridge_capabilities` trả danh sách action, limit, feature
    flag, mã lỗi và danh sách **cố ý không hỗ trợ kèm lý do**; `bridge_status` trả
    tình trạng chạy. Tài liệu đầy đủ: `docs/CONNECTOR_ACTIONS.md`.
14. **Fleet lifecycle đầy đủ**: `fleet_list`/`update`/`delete`/`run_now`/`runs`/
    `worker_status`/`worker_recycle`, kèm lịch sử vòng chạy có giới hạn. Mẫu "mỗi worker
    chạy N lượt rồi làm mới hội thoại" nay quan sát được (`fleet_runs`) và làm tay được
    (`fleet_worker_recycle`), đi qua đúng đường xóa hội thoại đã xác minh của rotation.

## Đã làm (2026-09-03) — parity với coding sandbox

Nguồn: đánh giá thứ hai của GPT-5.6 Sol sau khi dùng thật bề mặt 74 action, xếp theo
mức chặn: workspace tùy ý (P0), PTY/stdin (P0), đưa file vào Shiro (P0), xem ảnh/PDF (P1),
browser relay v2 (P1).

15. **Direct actions: 74 → 90.** Bốn họ mới: `workspace` (4), `terminal` (7), `media` (4),
    `network` (1). Toàn bộ 74 action cũ giữ nguyên hợp đồng — tham số `workspace` là
    tùy chọn và bỏ trống nghĩa là project root cố định như trước.
16. **Hết "một root cố định".** `workspace_open`/`create`/`list`/`close` cho phép địa chỉ
    hóa nhiều project. Đây là **lớp giới hạn thứ hai đặt trên Sandbox**, không phải cửa
    sau: người vận hành khai `SHIRO_WORKSPACE_ALLOWLIST` (allowlist chứa `/` bị từ chối
    lúc nạp cấu hình), allowlist được kiểm tra **trước cả sự tồn tại** để action không
    thành công cụ dò filesystem, realpath kiểm tra lại sau đó, và bên trong workspace thì
    luật cũ (path tương đối, không `..`, không symlink escape) nguyên vẹn.
17. **PTY thật với stdin.** `terminal_*` mở pseudo-terminal qua helper Python stdlib
    (`bridge/src/pty-bridge.py`, protocol JSON theo dòng) — không thêm native dependency.
    `terminal_read` **dựng lại** output như terminal vẽ (cursor motion, xóa dòng, repaint)
    nên echo của REPL đọc ra một dòng sạch; `wait_ms` + `settle_ms` chờ tới khi chương
    trình im lặng, biến viết-rồi-đọc thành một round-trip. Không có `python3` ⇒
    `UNSUPPORTED` kèm lý do, không giả vờ.
18. **Mang bytes vào máy.** `download_file`: http(s) only, cấm credential trong URL, ≤5
    redirect mỗi hop kiểm tra lại, chặn dải link-local (instance metadata), trần byte
    chặn cả theo `content-length` lẫn trong lúc stream, ghi atomic + `sha256`, và bắt buộc
    `confirm` vì vừa ra mạng vừa ghi đĩa.
19. **Nhìn được ảnh và PDF.** `image_open`/`pdf_render_page` trả MCP image block thật;
    `image_metadata` đọc kích thước từ header không giải mã; `pdf_info` cho số trang.
    Render đi qua stdout của poppler nên không rác trong workspace trừ khi `save_to`.
20. **Artifact URI biết workspace.** `shiro://artifact{?path}` giữ nguyên (mọi URI đã phát
    vẫn resolve) và có thêm template `{?path,workspace}`; `harness_get_artifact` nhận
    `workspace` tùy chọn.

21. **`artifact_import` — file ingress connector-native (sửa kết luận sai cùng ngày).**
    Bản đầu liệt kê action này là *unsupported* với lý do "tham số tool MCP là JSON nên
    không có kiểu file-reference". **Kết luận đó sai**: nó suy từ MCP thuần mà không kiểm
    chứng lớp ChatGPT connector runtime. Apps SDK của OpenAI có convention rõ ràng — khai
    `_meta["openai/fileParams"]: ["file"]`, tham số mang object
    `{download_url, file_id, mime_type?, file_name?}` (bắt buộc `download_url` + `file_id`).
    `artifact_import` nay dùng đúng convention đó và tái sử dụng nguyên bộ bảo đảm của
    `download_file` (trần byte, ghi atomic, sha256, chặn credential/link-local), cộng
    `destination` mặc định rút tên attachment về **một path segment** duy nhất. Hai dạng
    suy biến có thật (chuỗi file id, đường dẫn container `/mnt/data/...`) trả `UNSUPPORTED`
    **nói rõ nhận được gì** thay vì lỗi schema mù. Cổng `confirm` giữ nguyên như
    `download_file`: nếu miễn, action này thành đường vòng qua cổng đó.

Cố ý **không** làm, có ghi lý do trong `bridge_capabilities.unsupported[]`: emulator
terminal toàn màn hình (bộ dựng theo dòng đủ cho REPL/prompt; `raw: true` luôn có).

**Bài học quy trình**: "nhìn có vẻ bất khả thi từ tầng protocol" không phải bằng chứng.
Trước khi đóng một capability là `unsupported`, phải kiểm tra cả lớp runtime của client,
không chỉ spec của protocol.

22. **Harness workspace support — hết "agent bị nhốt trong repo Shiro".**
    `harness_start({workspace})` neo durable session vào workspace đã mở; engine workspace
    định danh theo path và session neo theo `cwd`, nên **mọi tool của engine** làm việc đúng
    cây đó. Hai tool Shiro tự đăng ký (`shiro-git-tool`, `shiro-container-tool`) không còn
    bind một root lúc `apply()` mà resolve theo `exec.agent.session.header.cwd`
    (`bridge/src/session-root.js`) — đúng quy tắc dsh-tool-fs đã dùng. Nếu bỏ bước này thì
    agent sẽ đọc file ở workspace B rồi commit vào repo Shiro: đúng kiểu sai âm thầm.
    Session **namespace theo workspace** (`harness_sessions({workspace})`, resume chéo bị từ
    chối kèm lý do), mọi payload của turn mang trường `workspace`, và id workspace lạ fail
    `NOT_FOUND` **trước khi** engine thấy path — allowlist chi phối cả agent turn. Bỏ trống
    `workspace` ở mọi nơi = hành vi cũ.

23. **Hardening cách ly control plane theo workspace.** Mở `harness_start({workspace})` mới
    chỉ là một nửa; nửa còn lại là mọi id opaque client cầm. Nay `operation_id`/`session_id`/
    `request_id`/`interaction_id` đều **mang sẵn workspace được đóng dấu lúc tạo** (request
    trong `broker.enqueue`, interaction trong `pumpEvents`), và gate so sánh giá trị đã ghi
    **trước khi** chạm engine — không phải nhận id rồi gọi engine rồi mới kiểm tra. Submit bị
    từ chối không tiêu request, approval bị từ chối không tiêu interaction, cancel bị từ chối
    không gửi gì cho engine. Sai workspace trả `NOT_FOUND` chứ không phải "sai workspace":
    xác nhận id tồn tại ở nơi khác chính là chỗ rò. Mọi nhánh suy luận ngầm ("chỉ một turn
    đang chạy", "turn gần nhất", payload `idle`) đều scope trong workspace, nên
    `harness_operation_list` không vô tình thành list-tất-cả; `bridge_status` vẫn đếm toàn
    bridge vì đó là con số về tải, không phải trạng thái.
24. **Workspace ghim vào realpath (TOCTOU).** `workspace_open`/`create` resolve symlink một
    lần lúc mở và lưu canonical path; đổi symlink sau đó không kéo workspace đang mở đi theo,
    và mở lại qua symlink đã đổi bị từ chối. Có test đổi symlink sau khi đã mở.

## Browser Relay v2 — Phase 1 (2026-09-03)

25. **Owned-tab gate tách thành một helper duy nhất** (`bridge/src/browser-ownership.js`,
    dependency-light như `session-root.js`). Ba luật nó tồn tại để cưỡng chế: authority đến
    từ registry của Shiro chứ không từ request (`browser_client_id` là **output**); tab lạ
    và tab không tồn tại trả lời **giống hệt** nhau (`NOT_FOUND`, cùng câu chữ) vì phân biệt
    được là xác nhận id nào có thật trong trình duyệt người dùng; và ownership được
    **re-check ngay trước relay call** bằng marker (client id + URL + worker + slot), nên
    tab đã điều hướng/đóng-mở lại/bị recycle → `CONFLICT`. `FleetManager` nay dùng chung
    helper này thay cho `#requireOwnedClient` riêng.
26. **`browser_tab_screenshot`** (92 action). Ảnh **không** vào JSON result: ghi atomic vào
    workspace, trả path + sha256 + kích thước + `shiro://` resource uri. Busy policy riêng
    cho từng action — screenshot là read-only nên được phép chạy khi tab đang generate,
    trong khi close/send_prompt vẫn `BUSY`. Magic byte phải khớp format yêu cầu; mọi thất
    bại không để lại file dở.
27. **Bug test bắt được**: helper kiểm tra `inspection.busy === true`, nhưng relay báo busy
    bằng **chuỗi bằng chứng** (`active_request`, `stop_control`, …). So sánh strict đó vô
    hiệu hóa toàn bộ busy policy — click/type sau này sẽ cắt ngang response ChatGPT đang
    chạy. Đã sửa thành coercion + giữ lại evidence, có test riêng.
28. **Sửa một khẳng định sai trong `unsupported[]`**: bản cũ ghi relay "không có route
    reload". Thực tế `POST /browser/tabs/reload` **có tồn tại** (`bridge.reloadBrowserTab`),
    và `POST /browser/layout/capture` cũng vậy. Chỉ `focus` và `screenshot` là thiếu.

29. **Relay + extension đã mở rộng thật (CDP).** Theo quyết định chọn `debugger` +
    Chrome DevTools Protocol: extension manifest thêm permission `debugger` (2.3.11 → 2.4.0,
    content runtime 4.3.9 → 4.4.0, floor tương thích nâng theo để extension cũ bị từ chối
    bằng "update required" thay vì lỗi "unsupported command" giữa chừng);
    `background/debuggerSessionManager.js` là lớp CDP dùng chung; `background/pageCapture.js`
    dùng `Page.captureScreenshot` (+ `Page.getLayoutMetrics` và `captureBeyondViewport` cho
    full-page); command `browser.tab.screenshot` chạy suốt manifest → content router →
    background → CDP; relay mở `POST /browser/tabs/screenshot` và khai
    `capabilities.browser.screenshot = true`.
    **Không** activate/focus tab, **không** resize cửa sổ — `max_width` là `clip.scale`.
    Relay suite: 965 → **985** test, tất cả xanh.

30. **Browser Relay v2 hoàn tất cả 5 phase (97 action).** Cùng một
    `DebuggerSessionManager`, không trộn `chrome.tabs`/content-script/CDP:
    `browser_tab_navigate` (`Page.navigate`), `browser_dom_query`
    (`Runtime.evaluate` với biểu thức cố định, selector chèn dạng JSON literal),
    `browser_tab_click`/`browser_tab_type` (`Input.dispatchMouseEvent` /
    `Input.insertText`), `browser_tab_evaluate` (`Runtime.evaluate`, làm cuối,
    bắt buộc `confirm`). Element handle opaque, scope theo **tab + document
    generation**; click/type resolve lại handle ngay trước thao tác. Busy policy
    theo action. Localhost/LAN được phép ở navigate theo quyết định mới; chỉ chặn
    scheme không phải http(s). Text đã gõ không echo lại; field password bị từ
    chối thẳng. Relay 965 → **1012** test, bridge 254 → **295**.

31. **Ba plugin engine đã có sẵn, nay được mount (2026-09-03).**
    - `dsh-schedule`: mount thẳng trong `bridge/cordis.patch.yml` (không cần config).
      **Đính chính một hiểu nhầm phổ biến**: delivery mode của nó cố định là
      `session-local` — reminder bắn *trong chính session tạo ra nó, khi session
      còn sống*. Đây **không phải** cron cấp project như scheduled task của Codex;
      automation định kỳ cấp project vẫn là fleet.
    - `dsh-lsp` + `dsh-lsp-stdio`: chỉ mount khi máy thật sự có language server.
      `bridge/src/engine-plugins.js` dò PATH và dựng bảng `servers`; bảng rỗng
      nghĩa là **không sinh row nào**.
    - `dsh-hooks-codex`: chỉ mount khi operator chỉ định `SHIRO_HOOKS_CONFIG`
      **và** đường dẫn đó resolve vào trong project root hoặc runtime dir. Hooks
      chạy shell command trên mọi tool seam, nên một path tùy ý là "code
      execution bằng cấu hình"; path xấu thì tắt hooks kèm lý do, không fallback
      và không chặn khởi động.

    **Vì sao sinh row thay vì khai-rồi-disable**: loader validate *mọi* field lúc
    boot và fail cả tiến trình nếu một row không hợp lệ; `lsp-stdio` bắt buộc
    bảng servers không rỗng, `hooks-codex` bắt buộc `configPath` có thật. Không
    xác minh được `disabled: !!js …` có được chấp nhận trên row insert hay không,
    nên chọn đường an toàn: row nào không chạy được thì **không tồn tại**. Block
    được splice vào profile patch layer giữa hai marker, giữ nguyên mọi thứ
    operator tự viết trong file đó (ví dụ pin bridge).

32. **Worktree isolation + handoff (P0 lớn nhất) — xong, 105 action.** Tám action họ
    `worktree`. Điểm thiết kế: **worktree được đăng ký thành workspace ngay trong
    `worktree_create`**, nên isolation không cần implementation song song — mọi action đã
    có (`fs_*`, `exec_run`, `git_*`, `terminal_*`) và cả `harness_start({workspace})` chạy
    nguyên vẹn trong checkout đó. Đích phải nằm trong allowlist, kiểm tra **trước** khi git
    chạy; `git worktree add` hỏng thì workspace vừa mở được đóng lại, không để lại workspace
    trỏ vào thư mục rỗng.

    **Snapshot là save point chứ không phải stash**: commit dựng từ index tạm (index thật
    không bị đụng), gồm cả file chưa track, ghim dưới `refs/shiro/snapshots/` nên sống qua
    `git gc` — có test `gc --prune=now --aggressive` khẳng định. **Restore và handoff là
    cùng một thao tác khác đích**, vì các worktree dùng chung object store nên không cần
    vận chuyển gì ở giữa.

33. **Bug test bắt được ở tầng apply.** Bản đầu dùng `git apply --3way --check`: nó báo
    `does not match index` cho patch **thực ra apply được**, và tệ hơn — khi conflict thật
    `--3way` **ghi conflict marker vào working tree**, phá vỡ lời hứa "conflict thì đích
    không bị đụng". Đổi sang `git apply --check` nghiêm rồi `git apply`. Đánh đổi đã ghi rõ
    trong docs: snapshot chỉ apply được nơi context còn khớp.

34. **Thread/turn protocol + session lifecycle — xong, 112 action.** Bảy action:
    `thread_events`, `turn_steer`, `thread_fork`, `thread_archive`, `thread_unarchive`,
    `thread_archived`, `thread_prune`. `thread_events` phẳng hóa transcript engine thành
    dòng item có `seq` ổn định, lọc được theo `types` và tiếp tục bằng `from_seq` — thứ
    `harness_session_log` không hứa.

    **Archive không đụng transcript.** Bridge chỉ ghi marker của riêng nó và mọi kết quả
    trả `engine_transcript_retained: true`. Quyết định này có lý do: một action tên
    "archive" mà xóa transcript engine sẽ là kiểu mất dữ liệu không ai hoàn tác được, còn
    "ẩn khỏi listing" thì `thread_unarchive` luôn lấy lại được. `thread_prune` **mặc định
    dry-run** và **từ chối quét không giới hạn** — một action dọn hàng loạt không nên chạy
    thật ở lần gọi đầu tiên.

35. **Permission profiles — xong, 114 action.** `permission_get` + `permission_set`, ba
    mức `read-only` → `workspace-write` → `full`. Trần từ launcher
    (`SHIRO_PERMISSION_PROFILE`); runtime **chỉ siết được, không nới**, và
    `permission_set('full')` từ `read-only` trả `PERMISSION_REQUIRED` nói thẳng rằng nới
    trần cần operator và restart.

    **Ghi rõ giới hạn thay vì bán quá lời**: đây là tuyên bố ý định ở biên action, không
    phải sandbox. `workspace-write` chặn mọi action *có mục đích* rời khỏi máy (họ
    `network`, họ `browser`, `git_fetch`/`git_pull`/`git_push`) nhưng không ngăn được
    `exec_run` chạy `curl` — ngăn điều đó là kiểm soát network của tiến trình con, việc
    lớp này không làm. Hai chi tiết đến từ việc thử phá chính nó: **browser read-only vẫn
    là outward** (nó chạm một phiên trình duyệt sống), và **allowlist lệnh từ chối
    `shell: true`** vì một dòng shell không phải một lệnh nên allowlist không bảo chứng
    được — nó bảo caller truyền `argv`.

36. **Review subsystem — xong, 118 action.** `review_diff` tách thay đổi theo hunk,
    `review_stage_hunk`/`review_revert_hunk` nhận hoặc bỏ đúng một hunk,
    `review_findings` đối chiếu nhận xét với thay đổi thật (`in_changed_file`,
    `in_changed_hunk`) nên một nhận xét về code ngoài phạm vi bị gọi tên.

    `hunk_id` **content-addressed**: cây đổi thì id cũ không mô tả gì nữa và action trả
    `CONFLICT` kèm lời nhắc chạy lại `review_diff`, thay vì áp patch vào thứ vừa trôi vào
    vị trí đó. Phạm vi review đặt bằng `since_snapshot` — nối thẳng với save point của
    mục 32, tức "đúng những gì turn này đã đổi" là một câu hỏi trả lời được.

    **Hai bug test bắt được**: `diff.mnemonicPrefix` của người dùng biến header thành
    `c/… w/…` khiến parser tin vào `a/`/`b/` đọc path thành `'c/app.txt w/app.txt'` — nay
    ghim `--src-prefix=a/ --dst-prefix=b/` và parser chấp nhận cả sáu prefix. Và tầm hunk
    tính sai bằng `new_start + additions + 1`; đúng là `new_lines` trong chính hunk header.

37. **CLI + SDK (P2 cuối) — xong.** `shiro` (bin), SDK JavaScript
    (`bridge/src/sdk.js`) và SDK Python (`bridge/sdk/shiro.py`, **chỉ thư viện chuẩn**:
    một script muốn đọc file không nên phải thêm dependency protocol — nó nói JSON-RPC
    qua HTTP và tự parse khung SSE).

    **Không làm `shiro exec "<prompt>"`, và đó là điểm chính.** Roadmap ghi "lớp tương
    đương `codex exec`", nhưng model của Shiro là ChatGPT đứng ở phía client MCP: một CLI
    muốn chạy trọn agent turn thì phải *là* model đó. Lệnh ấy sẽ start một turn rồi treo
    chờ người khác trả lời. Nên bề mặt trung thực là **toàn bộ direct action** — phần
    deterministic, cũng là phần lớn — cộng discovery (`shiro actions`, `shiro schema`) để
    script tự tìm action và schema mà không phải đọc tài liệu.

    Chi tiết học được khi viết: **ép kiểu phải dè dặt** — `"20"` thành số nhưng `1.2.3`
    và `007abc` giữ nguyên chuỗi, vì một sha hay version bị biến thành số là sai âm thầm;
    stdout phải **trống** khi action từ chối (mã lỗi ra stderr) để `shiro call … | jq`
    không bao giờ đọc nửa câu trả lời; SDK phải **ném** lỗi chứ không trả object lỗi, vì
    `await shiro.fs_read(...)` trả về object sẽ trông như đã chạy được; và Proxy của SDK
    JS phải trả `undefined` cho `then`, nếu không client trở thành thenable và mọi `await`
    trên chính nó sẽ treo. Trong thread helper, `session_id` áp **sau cùng** nên một
    `session_id` lạc trong tham số không chuyển hướng được lời gọi sang thread khác.

    Test đi qua HTTP thật (server per-request y như production, bearer check thật), không
    chỉ in-memory transport: 401 và connection-refused là hai đường mà transport hay sai
    nhất, và cả hai nay có mã thoát riêng (`3`) thay vì lặng lẽ thành công.

    **Đã chạy thật lên bridge đang sống** (2026-09-03, trong lúc bridge vẫn giữ 3 turn
    hoạt động): không cấu hình gì, CLI tự tìm token trong `.ShiroRuntime/state/` và port
    mặc định, rồi `shiro status` + `shiro call git_status` trả lời đúng. Bridge đó đang
    chạy **code cũ** — `bridge_version 0.1.0`, `direct_actions_version 1`, **74 action** —
    và CLI vẫn làm việc bình thường, đúng như thiết kế: nó *khám phá* bề mặt qua
    `bridge_capabilities` chứ không giả định một danh sách action biên dịch sẵn.

38. **Restart + reload extension — xong, và bắt được một bug tiềm ẩn.** `Stop-Shiro.sh`
    kill cả Chromium, `Start-Shiro.sh` deploy lại extension rồi khởi động Chromium với
    `--load-extension`, nên **restart chính là reload extension** — không cần thao tác
    `chrome://extensions` nào. Sau restart: bridge `0.2.0`,
    `direct_actions_version 3`, **118 action**, 16 họ; extension **2.4.0** (từ 2.3.11) kết
    nối, compatible với relay 6.3.14; 13 fleet rehydrate, 4 đang chạy. Ba turn cũ bị mất
    (cả ba đều đã treo ở `model_input_required` — hai cái ~10 giờ, một cái ~99 phút, không
    client nào trả lời); 52 durable session còn nguyên, resume được bằng session id.

    **Bug tìm ra khi smoke test CDP thật**: `browser.tab.screenshot` đầu tiên **treo im
    lặng 30 giây** rồi relay timeout, không có lỗi nào để đọc. Nguyên nhân cấu trúc:
    `chrome.debugger.attach` trả lời qua callback và là **await duy nhất không có timeout**
    trong toàn bộ đường CDP — mọi `sendCommand` đều đã bounded, riêng attach thì không.
    Một callback không bao giờ được gọi biến thành treo vô hạn. Đã chặn timeout 8s cho
    attach, kèm thông điệp nêu đúng nghi phạm ("debugger permission may not be granted"),
    và **timeout không được đi vào nhánh recovery already-attached** — nếu không nó sẽ
    attach lần hai rồi chờ lại từ đầu. Hai test mới khẳng định cả hai điều đó.

    Sau khi reload extension (background epoch mới), screenshot chạy **155ms**: PNG thật
    1545x776, `fullPage` đúng kích thước nội dung, `browser.dom.query` trả 118 button với
    element handle scope theo document generation. Tức `debugger` permission **có** được
    cấp; cái treo là một trạng thái service worker lúc khởi động mà giờ đã bounded thay vì
    im lặng.

    **Ownership gate xác minh trên máy thật**: tab ChatGPT do launcher mở không thuộc fleet,
    và connector từ chối đúng như thiết kế — `browser_tab_screenshot` trả
    `NOT_FOUND: browser tab 109286204 is not an open Shiro-owned tab` (CLI exit 1), giống
    hệt phản hồi cho một tab không tồn tại. Cùng tab đó relay vẫn chụp được khi gọi trực
    tiếp: đúng ranh giới đã thiết kế — gate bảo vệ *bề mặt connector*, không phải bịt CDP.

39. **Hai lỗi hạ tầng sửa cùng đợt.** (a) `npm run check` của relay fail: `src/routes.js`
    (1045) và mock `extension-client.js` (1060) vượt trần 1000 dòng **do chính các thay đổi
    browser v2**. Tách `src/http/browserTabRoutes.js` (mọi thứ tác động lên *một* tab:
    open/reload/navigate/screenshot/dom/evaluate/close — chúng chung một tiền đề và chung
    vòng đời tab) và `scripts/e2e/mock-chatgpt/browser-automation.js`. Còn 923 và 965.
    (b) `Start-Shiro.sh` in `jq: parse error` mỗi lần khởi động: `${current_health:-{}}` —
    dấu `}` đầu **đóng expansion**, nên bash nối thêm một `}` và jq nhận `{...}}`. Nó *vẫn*
    chạy đúng vì jq in giá trị trước khi nghẹn dấu ngoặc thừa, nhưng đó là đúng-do-may: chỉ
    cần jq đổi thứ tự output/error là guard biến thành false negative và startup fail giả.

40. **Bốn mục P0 từ đánh giá release — verify trước, sửa sau.** Cả bốn đều **đúng**; đã
    kiểm chứng từng cái trước khi đụng code, vì trong dự án này đã hai lần đánh giá sai
    (mục 21 và mục về `artifact_import`).

    **P0.1 — permission không phủ hết bề mặt: đúng, 12/118 action lọt.** `assertAction`
    chỉ được gọi trong `defineAction`; `harness_*` và `fleet_*` đăng ký thẳng bằng
    `server.registerTool` trong index.js. Nghĩa là `read-only` **không** chặn được
    `harness_start` — một agent ghi được mọi thứ — hay `fleet_start`. Sửa bằng
    `src/action-gate.js`: một gate duy nhất, cả hai đường đăng ký đều gọi, và **ném lỗi
    ngay lúc đăng ký** nếu một tool không có registry row (không có row thì không phán
    quyết được, mà im lặng cho qua chính là lỗ này).

    Điều giữ cho nó không tái diễn không phải là gate mà là `permission-coverage.test.js`:
    nó bắt **mọi** tool đã đăng ký, gọi từng handler dưới profile `read-only`, và fail nếu
    action ghi nào chạy được. Test đó lập tức bắt thêm một lỗ thứ hai chưa ai nêu:
    `fleet_start` lọt qua `workspace-write` vì họ `fleet` không nằm trong outward — trong
    khi nó **mở tab browser và gửi prompt tới ChatGPT**. Nay tách: fleet **ghi** là outward,
    fleet **đọc** là local (state trên đĩa, không chạm relay).

    **P0.2 — command chỉ giới hạn `cwd`: đúng.** Nhưng đề xuất "đưa qua sandbox provider
    của DSH" hoá ra chính xác hơn cả kỳ vọng: engine **đã mount sẵn**
    `@deepseek-ai/dsh-sandbox-local` (backend bwrap/landlock) + `dsh-sandbox-policy` trong
    `packages/bundle/base/cordis.patch.yml`, mặc định `workspace-write` + `approval: ask`.
    Tức agent turn đã được confine ở mức OS; chỉ **direct action của bridge** là spawn
    thẳng. `src/confinement.js` định tuyến spawn của bridge qua đúng seam đó
    (`ctx.sandbox.confine(argv, policy)` trả argv để spawn thay). Ba quyết định:

    * **Fail closed**: profile bị siết mà không có provider thì **từ chối chạy**, không
      chạy trần rồi im. Đây là cách một lần chạy "read-only" âm thầm thành full-access.
    * **Báo cáo thay vì tuyên bố**: mỗi kết quả mang `sandbox: {mode, enforcement, backend}`
      — người gọi *kiểm tra được* biên, không phải tin chữ "sandboxed".
    * **Shell line confine thành `['bash','-c', line]`**, vì seam confine đúng một argv, và
      confine chính shell là cách duy nhất mọi stage của pipeline thừa hưởng biên đó.

    Vocabulary khớp 1:1 (`read-only`/`workspace-write`/`full`→`danger-full-access`) nên
    không cần lớp dịch. Máy này có **bwrap 0.11.2** → confinement là thật, không danh nghĩa.
    Đã áp cho `exec_run` và `process_start` (process nền là lỗ sống lâu nhất trong hai
    đường). **Chưa áp** cho terminal/task/git — cùng một helper, còn lại là việc nối dây.

    **P0.3 — runtime closure fail: đúng, và là hai vấn đề khác loại.**
    `@deepseek-ai/dsh-tool-session-query` là **thiếu sót thật** từ commit bật nó
    (`0692b66`): package có trong workspace, chỉ chưa khai trong `python/sdk-runtime`. Đã
    thêm, 9 dòng lỗi biến mất. `@shiro-ai/harness-bridge` thì **không phải bug khai thiếu**
    mà là vi phạm phân tầng: preset *của engine* (`apps/cli/config/agent-presets/*`) tham
    chiếu package tầng sản phẩm của Shiro, và runtime đóng gói của engine không thể phụ
    thuộc ngược lên đó. Chạy được hôm nay chỉ nhờ `link:` trong profile package.json — đúng
    như đánh giá nói. Cần quyết định, xem phần dưới.

    **P0.4 — review bỏ sót file untracked: đúng, và là bug nặng nhất trong bốn.** Đúng
    những file agent vừa tạo — thứ đáng review nhất trong một turn — không xuất hiện.
    `git add -N` sẽ khiến git thấy chúng nhưng **đụng vào index**; một action review tự ý
    stage sau lưng người gọi còn tệ hơn bỏ sót. Nên mỗi file untracked được diff
    `--no-index` với `/dev/null` ngoài cây rồi viết lại header về đúng dạng
    `diff --git a/x b/x`. `locateHunk` dùng **cùng một văn bản**, nếu không một hunk id
    bridge vừa phát ra sẽ không địa chỉ hoá được và người gọi đọc thành "id cũ" trong khi
    chẳng có gì cũ. `.gitignore` vẫn là câu trả lời của repo cho "cái này có thuộc công việc
    không"; `staged`/`base` không kèm untracked vì ở đó khái niệm đó vô nghĩa.

41. **Biến ChatGPT Web thành coding-agent model thật — xong, 118 → 122 action.**
    Bốn quyết định của yêu cầu này, mỗi cái một đánh đổi rõ ràng:

    **Bỏ mọi `confirm: true` mặc định.** Đây là môi trường riêng của người vận hành: một
    vòng "gọi → bị từ chối vì thiếu confirm → gọi lại y hệt kèm `confirm: true`" không cản
    được gì, vì cùng một client trả lời chính câu hỏi nó tự đặt ra — chỉ tốn một round-trip.
    Đặt module-level (`confirmationsAreRequired()` trong `action-errors.js`) thay vì threading
    qua 11 call site không bao giờ đổi giá trị. **Mặc định tắt, `SHIRO_REQUIRE_CONFIRMATIONS=1`
    bật lại** — không xoá cơ chế, chỉ đổi giá trị mặc định; `bridge_capabilities` báo
    `requires_confirmation` đúng như nó sẽ hành xử thay vì quảng cáo một phanh đã tắt.

    **Kho plugin DSH lộ ra bằng cách soi gương, không phải cổng gateway.** Người dùng chọn
    "mirror native: mỗi tool DSH thành MCP tool riêng" thay vì `plugin_call(name, args)` —
    gần với cảm giác "skill" của Codex hơn. `bridge/src/engine-tools.js` đọc
    `ctx.tools.schemas()` của engine (chính registry agent loop dùng) và đăng ký từng cái
    qua `ctx.tools.execute()` — không danh sách tay, tự lớn theo plugin mount thêm.
    `bridge/src/json-schema-zod.js` là phần khó: schema tham số của DSH là JSON Schema
    thô, còn MCP SDK build `inputSchema` từ Zod shape. Converter **lệch có chủ đích về một
    hướng** — thứ không hiểu thành `z.unknown()` permissive chứ không đoán liều: một schema
    sai-mà-cụ-thể sẽ khiến connector từ chối lời gọi mà plugin lẽ ra chấp nhận; một schema
    permissive chỉ khiến model thấy ít gợi ý hơn, còn engine tự validate argument của nó.
    Tên trùng action Shiro có sẵn đổi thành `dsh_<tên>` thay vì ghi đè, và **soi gương chạy
    sau cùng** để `taken` là tập tên đầy đủ. Mọi tool mirror qua **đúng permission gate**
    của mục 40 (P0.1) — khai bảo thủ `read_only: false` vì bridge không biết trước plugin
    bất kỳ làm gì.

    **Watchdog "phút 27" gõ vào tab cá nhân của người dùng, không vào fleet.** Người dùng
    chọn phương án nudge trực tiếp hội thoại đang chạy — giữ nguyên workflow "bạn chat, nó
    tự hồi sinh" — thay vì chuyển agent sang chạy trong tab fleet. Đây là quyết định có chủ
    ý nới ownership gate: `continuation_set` là **action browser duy nhất** nhận một tab
    không thuộc fleet, và chỉ nhận đúng một quyền hẹp (gõ đúng một dòng text đã cấu hình,
    không phải quyền chung của automation) — designation sống trong bộ nhớ, mất khi bridge
    restart, không phải standing config. `ContinuationWatchdog` (`bridge/src/continuation.js`)
    quét mỗi 30s qua `BridgeBroker.waiting()` (mới thêm: tuổi từng pending model request);
    một turn vượt `after_minutes` (mặc định 27 — sau mốc cắt ~25 phút của nền tảng, đủ xa để
    không ngắt một câu trả lời chỉ đang chậm) mới bị nudge, **mỗi vòng quét đúng một nudge**
    dù nhiều turn cùng treo (nudge turn cũ nhất; hai dòng "continue" liên tiếp đọc như nhiễu
    với model phải hành động theo đó). **Nudge thất bại không trừ ngân sách và không bắt đầu
    cooldown** — turn vẫn đang treo, từ chối thử lại là bỏ rơi nó. `max_nudges` (mặc định 8)
    tự dừng thay vì gõ vô hạn vào một turn đã chết hẳn.

    **Xác nhận trực tiếp trên máy đang chạy 3 turn treo thật**: hai turn ~10 tiếng, một
    ~99 phút, đúng những gì watchdog này nhắm tới — không phải kịch bản giả định.

    433 bridge test (416 → 433), 122 action. Toàn bộ implementation (97 file, những gì tồn
    tại trước đó chỉ trên một đĩa) và round này đã commit lên `feat/coding-sandbox-parity`.

42. **Sub-agent CLI thật (Claude Code / Codex / Grok / Antigravity) — xong, 122 → 128
    action.** Yêu cầu: ChatGPT Web không có kho skill như Codex; cho nó gọi được bốn CLI
    coding agent thật như sub-agent của chính mình bù lại việc đó.

    **Điều tra trước khi viết dòng nào**: cả 4 đều thật trên máy (không đoán, không tin lời
    người dùng chưa kiểm) — `claude` 2.1.251 và `codex` 0.151.0 đã đăng nhập, chạy live được;
    `grok` 1.0.13 cài nhưng chưa `grok login`; `agy` (Antigravity, người dùng cung cấp đường
    dẫn) 1.1.25 tại `~/.local/bin/agy` — verify bằng `file`+`--version` thật trước khi tin,
    cũng chưa đăng nhập. Probe live cho `claude -p --output-format json` và
    `codex exec --json` xác nhận đúng hình dạng response; `grok`/`agy` build từ `--help` với
    nguyên tắc suy giảm an toàn vì không đăng nhập được để xác minh — mọi kết quả của hai
    adapter này mang `unverified: true`.

    **Kiến trúc: xây trên `ProcessRegistry` có sẵn, không viết lại.** Một subagent LÀ một
    tiến trình bridge sở hữu theo mọi tiêu chí đã có — PID, ring buffer, confinement, trần
    số tiến trình đồng thời — nên `bridge/src/subagents.js` chỉ thêm phần đặc thù CLI
    (chọn adapter, dựng argv, phân tích output thành `thread_id`/`message`) trên lớp đã có,
    thay vì một registry song song. `bridge/src/subagent-adapters.js` tách riêng phần thuần
    (dựng argv, parse transcript) khỏi phần I/O — test được không cần spawn.

    **Chạy nền, không đồng bộ.** Một CLI có thể chạy hàng chục phút; ChatGPT tự nó bị nền
    tảng cắt ~25 phút (mục 41). `subagent_start` trả `process_id` ngay; `subagent_status`
    hỏi lại — tránh đúng việc cộng dồn hai giới hạn thời gian vào nhau.

    **Cổng disclaimer không bị vượt qua.** `claude`/`grok` khoá `bypassPermissions` sau một
    bước xác nhận tương tác một lần. Thử nghiệm trực tiếp: `claude --bg` với
    `bypassPermissions` từ chối thẳng, đòi chạy `claude --dangerously-skip-permissions` một
    lần trong terminal thật trước. `subagent_start` tôn trọng đúng ranh giới đó — yêu cầu
    mode này bị từ chối `PERMISSION_REQUIRED` kèm đúng lệnh mở khoá, không script qua.
    `codex`/`agy` không có cổng tương tự nên bypass của chúng đi thẳng.

    **Hai bug thật bắt được khi build integration test bằng fixture CLI (không đụng CLI
    thật, không tốn phí, không cần đăng nhập):**
    1. `SubagentRegistry.start()` **quên ghép `adapter.binary` vào argv** — mọi adapter thật
       (cả 4) sẽ hỏng ngay từ lệnh spawn đầu tiên trong production, chỉ vì `buildArgv()`
       (đúng theo hợp đồng) trả về tham số CLI chứ không phải chính binary. Test tích hợp
       dùng `ProcessRegistry` + `Sandbox` thật, chỉ giả `binary` bằng một script Node nhỏ,
       lộ ra ngay ở lần chạy đầu — `executable is not runnable`.
    2. **Auth probe đọc sai stream/exit code.** So khớp `subagent_providers` với sự thật đã
       biết (`claude`/`codex` đăng nhập, `grok`/`agy` thì không) lộ ra hai cái sai:
       `codex login status` in "Logged in using ChatGPT" ra **stderr**, không phải stdout —
       classifier chỉ đọc stdout luôn trả `null`. Và `#probe()` chỉ gọi `classifyAuth` khi
       tiến trình probe thoát mã 0 — đúng cho `grok` (thoát 0 dù chưa đăng nhập) nhưng sai
       cho `agy` (thoát 1 khi chưa đăng nhập, nên classifier không bao giờ được gọi). Sửa:
       luôn gộp cả stdout+stderr, luôn gọi classifier bất kể exit code — bản thân mỗi
       classifier đã tự trả `null` khi không nhận ra gì, tầng gọi không cần đoán hộ.
       Sau khi sửa, `subagent_providers` chạy thật khớp 100% với trạng thái đăng nhập thật
       của cả 4 CLI.

    **Quyền**: họ `subagent` outward-on-write giống `fleet` — `subagent_start`/`_stop` cần
    `full`, action đọc (`status`/`log`/`list`/`providers`) chạy được ở `read-only`.

    477 bridge test (433 → 477).

43. **"Sửa hết lỗi" — bốn lỗi thật, ba trong số đó chỉ restart mới lộ ra.** Chạy đủ mọi
    suite trước (bridge 477/477, relay **1010/1010** — lần đầu chạy full 159 file, relay
    `npm run check` xanh, 4 engine verify gate xanh) rồi mới đi tìm chỗ chưa chạy.

    **(1) Startup lock bị giữ vĩnh viễn — Shiro không restart được nữa.**
    `Start-Shiro.sh` giữ lock qua `exec 9>start.lock`; fd 9 **thừa kế xuống mọi tiến trình
    con**. Script đã xử lý đúng ở 3 chỗ (`9>&-` cho `start_detached` và chromium) nhưng
    **sót hai lệnh `xdg-open`** mở UI. `xdg-open` giao URL cho **Chrome cá nhân của người
    dùng**, và Chrome đó giữ lock cho tới khi đóng hẳn — đo được: 3 giờ 28 phút, khiến
    `Start-Shiro.sh` chết với "Another Shiro startup is already running" trong khi **không
    có startup nào đang chạy**. Thêm `9>&-` vào đúng hai chỗ đó. Dọn lock kẹt bằng
    `rm` (holder giữ fd tới inode đã unlink, vô hại) thay vì giết trình duyệt của người dùng.

    **(2) Lockfile engine lệch — backend chết ngay khi boot.** Bản sửa P0.3 ở mục 40 thêm
    `@deepseek-ai/dsh-tool-session-query` vào `python/sdk-runtime/package.json` nhưng
    **không regenerate `pnpm-lock.yaml`**, mà engine boot bằng `--frozen-lockfile`. Lỗi nằm
    im từ mục 40 vì suốt các round sau **không ai restart**; lần restart đầu tiên là lần đầu
    nó lộ ra. `pnpm install --lockfile-only` → 3 dòng. Bài học đúng loại: một thay đổi
    package.json chưa restart thì chưa biết nó đúng.

    **(3) Plugin mirror đăng ký 0 tool — cordis chặn đọc service chưa inject.** Mục 41 mirror
    kho plugin DSH qua `ctx.tools`, nhưng cordis **enforce** inject: đọc service không khai
    thì **ném** `cannot get property "tools" without inject`. `engineToolsOf` bắt exception
    rồi trả `null` — trông y hệt "host này không có engine" trong khi engine ở ngay đó, và
    mirror im lặng đăng ký 0 tool. Test cũ không phơi ra được vì chúng truyền thẳng object
    registry vào, không đi qua ctx thật. Sửa bằng `ctx.reflect.get('tools', false)` — đúng
    API cordis tài liệu hoá cho "đọc service không cần inject", trả `undefined` thay vì ném.
    (Không dùng `inject: ['tools']`: dạng mảng của cordis khiến service thành **bắt buộc**,
    bridge sẽ không mount nổi trên host không có tool registry.)

    Cùng lúc sửa lỗi thứ hai cùng chỗ: registry đọc **một lần lúc boot** nên plugin mount
    sau bridge vĩnh viễn vô hình. Đổi sang **resolver gọi mỗi request** — hợp với việc mỗi
    HTTP request đã dựng một `McpServer` mới.

    **(4) Tài liệu nói quá về phạm vi mirror.** Sau khi sửa, đo trên engine thật: **6 tool**
    (`memory_*`), không phải LSP/todo/plan như mục 41 viết. Nguyên nhân kiến trúc:
    `schemas()` không-scope chỉ trả **layer global**; tool của agent nằm trong scope của
    từng preset. Đã sửa cả docs lẫn comment trong module cho khớp sự thật đo được thay vì
    để lại lời hứa sai — `harness_start` vẫn là đường tới nhóm tool đó.

    **Live sau khi sửa**: 134 action (128 + 6 mirror), `subagent_providers` khớp đúng trạng
    thái thật của cả 4 CLI, không còn `jq: parse error` lúc khởi động. 479 bridge test.

44. **Lỗi thứ năm, tìm ra khi trả lời "có ảnh hưởng gì không" — hai tool của agent chưa
    bao giờ nạp được.** Câu hỏi nhắm vào gate `verify-runtime-closure` còn đỏ. Thay vì
    nhắc lại phán đoán "không ảnh hưởng", đi kiểm chứng: import thẳng hai specifier mà
    preset khai, từ đúng thư mục profile. Kết quả: **cả hai fail**.

    `@shiro-ai/harness-bridge` (bản thân bridge) resolve tốt, nhưng
    `@shiro-ai/harness-bridge/container-tool` và `/git-tool` trả `ERR_MODULE_NOT_FOUND` —
    gốc là `Cannot find package '@deepseek-ai/dsh-tools'`. Profile link bridge bằng
    **symlink**, mà Node resolve import của một package symlink theo **realpath** của nó,
    nên `import '@deepseek-ai/dsh-tools'` trong `bridge/src/container-tool.js` bị tìm dưới
    `bridge/`, không phải dưới profile đã link nó. Peer đó khai `optional` và
    `bridge/pnpm-workspace.yaml` đặt `autoInstallPeers: false`, nên **không gì từng cài nó**:
    `bridge/node_modules` chỉ có `@modelcontextprotocol` và `zod`.

    **Vì sao không ai thấy**: một preset row không import được sẽ mang theo luôn container
    tool và git tool của agent mà **không log gì cả** — `backend.stderr.log` sạch 0 dòng.
    Và 128 direct action của bridge không hề bị ảnh hưởng (chúng nằm trong `index.js`, không
    import `dsh-tools`), nên mọi suite vẫn xanh. Đây đúng là loại lỗi chỉ lộ ra khi hỏi
    "*chứng minh* đi" thay vì "test có xanh không".

    Sửa trong `Prepare-Shiro-Runtime.mjs` — nơi đã sở hữu việc link runtime: tạo
    `bridge/node_modules/@deepseek-ai/dsh-tools` trỏ (tương đối, để checkout còn di chuyển
    được) tới `engine/packages/core/tools`, idempotent. Sau restart, cả hai entrypoint
    resolve OK. Thêm test hồi quy import thẳng hai module đó.

    **Trả lời câu hỏi gốc**: gate closure đỏ tự nó không ảnh hưởng vận hành (Shiro không
    build/ship `python/sdk-runtime`, không script nào đụng tới nó) — nhưng đi kiểm chứng
    nó đã lôi ra một lỗi thật, khác hẳn, đang làm agent thiếu hai tool.

45. **Audit release: 4 blocker, cả 4 đều đúng, đã sửa và chứng minh trên runtime sống.**

    **(1) Package bridge không phát hành độc lập được.** `npm pack` bỏ sót **9 module** mà
    exports với tới bắc cầu (`action-gate`, `browser-dom`, `browser-navigate`, `confinement`,
    `continuation`, `engine-tools`, `json-schema-zod`, `subagent-adapters`, `subagents`), và
    `sdk.js` — thứ tài liệu gọi là public SDK — **không hề được export**. Chạy được lâu nay
    chỉ vì profile dùng `link:` kéo nguyên thư mục, nên `files[]` sai mà không ai biết. Đã
    thêm export `./sdk`, đồng bộ `files[]` theo **bao đóng thật**, và quan trọng hơn là gate
    `tests/package-closure.test.js`: tính lại bao đóng, đối chiếu với `npm pack --json` của
    chính npm, rồi **pack → cài vào thư mục trống → import từng export**. Đó là bài kiểm tra
    duy nhất bắt được lỗi gốc, vì nó làm đúng thứ người dùng làm.

    **(2) Deployment chưa hề được sandbox — confinement hoàn toàn vô hiệu.** Audit chỉ ra
    `sandboxProviderOf()` có **cùng dạng lỗi** với plugin mirror ở mục 43: đọc `ctx.sandbox`
    trực tiếp, cordis ném vì chưa inject, catch trả `null`. Đúng — và hệ quả tệ hơn mirror:
    mọi lệnh chạy trần trong khi **báo cáo `enforcement: "none"` như thể đó là lựa chọn của
    người vận hành**. Sửa sang `ctx.reflect.get('sandbox', false)` + resolve mỗi request.
    Đồng thời `sandbox_mode` bị đọc trong `exec-actions.js` nhưng **chưa bao giờ khai trong
    input schema**, nên caller không siết được từng lời gọi — đã khai cho `exec_run` và
    `process_start`.

    Chứng minh trên máy thật, không phải fake provider:
    ```
    sandbox_mode: read-only      → {mode: read-only, enforcement: full, backend: bwrap}
    ghi /tmp                     → exit 1, "Read-only file system"
    sandbox_mode: workspace-write→ ghi trong workspace OK
    ```

    **Còn nợ, ghi rõ thay vì lờ đi**: confinement mới nối vào `exec_run` + `process_start`.
    `terminal_start`, `task_run`/`test_run`, git/worktree, poppler và các probe phụ vẫn spawn
    ngoài sandbox. Và sandbox này chỉ kiểm soát **file effect** — network của tiến trình con
    vẫn tự do (cần egress proxy/netns, chưa làm). Mặc định vẫn `full`/no-confirm **theo đúng
    lựa chọn đã ghi của người vận hành** ở mục 41, không tự ý đảo lại.

    **(3) Runtime closure đỏ — sửa bằng hướng thứ ba, không phải hai hướng audit nêu.**
    Audit đề xuất: hoặc biến hai tool thành package engine-owned, hoặc bỏ khỏi preset engine
    rồi chèn bằng Shiro profile patch. Kiểm tra thì preset **không có cơ chế overlay/include**
    (`includeRuntimeContext` chỉ là field config), nên hướng thứ hai đòi **nhân bản nguyên
    một preset** — bẫy bảo trì tệ hơn vấn đề nó sửa. Hướng thứ ba, rút ra từ `view(scope)`
    của engine: **tool ở layer global được mọi agent scope kế thừa**. Nên hai row chuyển về
    đúng `bridge/cordis.patch.yml` — bundle patch Shiro sở hữu hoàn toàn — và bị gỡ khỏi cả
    ba preset của engine. Không đụng source engine, không nhân bản gì, không đảo tầng.

    Gate xanh: *"4 agent presets and 120 workspace packages form a closed runtime dependency
    graph"*. Và chứng minh agent **không mất tool**: sau restart, plugin mirror hiện
    `sandbox_exec` cùng 7 git tool (`dsh_git_*` — luật đổi tên khi trùng của mục 41 chạy đúng
    trong production).

    **(4) LSP chưa tới model.** Đúng: block sinh ra mount `dsh-lsp` (capability) và
    `dsh-lsp-stdio` (transport), nhưng **không** `dsh-tool-lsp` — package duy nhất trong ba
    cái *đăng ký một tool*. Effective config trông đủ trong khi agent không có `lsp` để gọi.
    Thêm row thứ ba. Chứng minh: sau restart, `lsp` xuất hiện trong bề mặt.

    **Live cuối đợt**: 143 action (128 direct + 15 plugin mirror), 485 bridge test,
    `verify-runtime-closure` xanh. Sửa thêm hai nhiễu khởi động cùng loại với `jq` ở mục 39:
    probe tunnel in `curl: (22) 503` vì `--show-error` giữa vòng retry.

## Lộ trình còn lại (thứ tự cập nhật 2026-09-03)

### ~~P0 — Harness workspace support~~ ✅ làm xong 2026-09-03 (mục 22)

Ba điều khảo sát engine xác nhận, ghi lại vì mọi thay đổi sau này dựa vào chúng:
`apiProxy.workspace.create({payload:{path}})` định danh workspace theo path;
`packages/workspace/workspace/src/types.ts` — "a session header whose canonical cwd equals
the workspace path"; `packages/fs/tool-fs/src/session-cwd.ts` — "each session's
read/write/edit act on ITS workspace, not the server's launch dir".

### ~~P1 — Browser relay v2~~ ✅ xong 2026-09-03 (mục 29–30)

`screenshot` → `navigate` → `click`/`type` → `DOM/query` → `evaluate` (cuối cùng). Mọi bước
gắn với **verified owned tab**; `evaluate` để cuối cùng và **không** cho chạy trên foreign
tab kể cả khi `include_foreign=true` (cờ đó chỉ để *xem*, không để thực thi).

Ghi chú thứ tự chi phí sau khi khảo sát relay: **screenshot là phase duy nhất cần permission
mới của Chrome**. `navigate` có thể dựng trên route tab đã có, và DOM query đã có sẵn
`POST /browser/layout/capture` (bounded theo `maxNodes`/`maxBytes`) — tức phase 4 rẻ hơn
phase 1 trên deployment này. Thứ tự rủi ro thì screenshot vẫn đúng là thấp nhất; đây chỉ là
dữ kiện chi phí để bạn quyết, không phải đề nghị đổi thứ tự.

### ~~P2 — Public SDK/CLI automation~~ ✅ xong 2026-09-03 (mục 37)

`shiro` + SDK JS + SDK Python, resume bằng session id. Phạm vi đã cắt lại có chủ ý: bề
mặt là direct action, không phải `shiro exec "<prompt>"` — lý do ở mục 37.

### P2 — Safe restart orchestration

Thay `bridge_reload` (nghịch lý tự giết request đang trả lời) bằng `restart_when_idle()`:
action chỉ ghi một restart request bền vững rồi trả về thành công; supervisor **ngoài
process** thấy `active_turns == 0` thì restart engine.

## Lộ trình MCP protocol (giữ nguyên thứ tự cũ)

1. **MCP Tasks** — thay vòng start/status/continue thủ công bằng task-augmented execution
   (`capabilities.tasks`, `tasks/get|result|cancel`, trạng thái working/input_required/…),
   giữ API cũ làm compatibility layer.
2. **Progress notifications** — `_meta.progressToken` + `notifications/progress` cho
   phase/tool/test (throttled), giảm poll rỗng.
3. **Resources/Prompts** — Resources (`shiro://sessions/{id}/log`, diff, test report)
   thay vì nhét tất cả vào tool result; Prompts cho workflow người dùng chọn
   (review-code, fix-tests, resume-session).
4. **Artifact nâng cao** — bước đầu đã có `harness_get_artifact` (xem mục 7 ở trên);
   còn lại: resource link/`resources/read` đúng chuẩn thay cho tool-call, listing
   artifact của một turn, và ảnh quá 6MB tự resize phía bridge.
5. **Giới hạn kích thước** — ✅ phần chính đã làm (2026-09-01): turn outcome chỉ mang
   summary của model_requests (kèm `request_id`/`state`/`pending_action` phẳng);
   body đầy đủ lấy qua `harness_get_request` phân trang (`messages_from`, trần
   80KB/trang) — hết cảnh ChatGPT elide tool result thành "Skipped messages".
   Còn lại: paginate log dài trong completion events nếu về sau chúng phình to.
6. **Cancellation MCP-native** — xử lý notification cancel của client, map về turn/task.
7. **tools/listChanged** — khai capability + notification khi đổi schema; nhắc user
   Refresh app trong ChatGPT sau mỗi lần đổi bề mặt tool.
8. ~~**Cân nhắc tách tool theo quyền**~~ — ✅ làm cùng đợt direct action: mỗi action
   khai `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` đúng hạt, và
   `bridge_capabilities` liệt kê `read_only`/`destructive`/`requires_confirmation` cho
   từng action. Tên connector ngắn "Shiro" + icon ổn định vẫn là việc phía ChatGPT.

8. ~~**Browser relay v2**~~ — ✅ xong 2026-09-03, cả 5 phase qua CDP. Ghi chú cũ: relay đã
   audit chỉ mở clients / layout capture / tab open / tab close / passive prompt /
   session delete. Thêm được đòi mở rộng bề mặt extension, nên nằm sau khi mô hình
   ownership tab được siết lại — không phải việc vá thêm một route.
9. **Python session stateful** — hiện `terminal_start` với `python3 -i` đã cho REPL sống
   lâu có state; một họ `python_*` riêng chỉ đáng làm nếu cần structured result
   (dataframe/plot) chứ không phải text.

Ghi chú vận hành: ChatGPT cache danh sách tool per-app — sau mỗi thay đổi bề mặt MCP,
mở `chatgpt.com/plugins` → app Shiro → Refresh/Save để nạp lại.
