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
