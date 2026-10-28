---
description: Push the efficiency board to the dashboard Artifact (desktop app; run in a Haiku session)
argument-hint: "[--titles]"
allowed-tools: Bash(node:*), ArtifactData, mcp__ccd_session_mgmt__get_usage, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__get_session, mcp__ccd_session_mgmt__set_session_model, mcp__ccd_turn__wrap_up
---

Haiku 세션에서 돌리세요. 앱 모델 메뉴에서 Haiku 로 바꾸거나 `start_session(model:'haiku')` 로 갱신 전용 탭을 열어요. 이 명령은 판단이 없어요: 계산·제안·건너뛰기 판정은 전부 스크립트가 하고, 이 세션은 아래 도구를 순서대로 부르고 JSON 을 그대로 넘기기만 해요. 한 번에 한 줄씩만 보고하고 오너에게 한국어로 말해요.

0. 이 세션이 Haiku 가 아니면 "더 싼 탭(Haiku)에서 돌릴 수 있어요" 를 한 줄 알리고 계속해요(막지 않아요).

1. `ArtifactData` 도구가 없으면 `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.js" --json` 결과 표를 보여주고, "데스크탑 앱에서 대시보드 페이지를 Artifact 로 게시한 뒤 `dashboardUrl` 을 설정하세요" 를 안내하고 끝내요. `dashboardUrl`(`~/.claude/token-stamina/config.json`)이 비어 있어도 같아요.

2. 비용 측정 전: `get_usage`(self) 의 Messages 토큰을 `T0` 로 적어 둬요. 안 되면 `T0` 없음.

3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.js" --rows` 를 실행해요. 출력이 `{"skip":true,"reason":...}` 면 `reason`(`budget` 이면 하루 예산 초과, `unchanged` 이면 직전 갱신과 같음)만 한 줄로 알리고 4~6번(제목·버전·batch)과 `--record-push` 는 건너뛰어요. 승인된 결정이 기다릴 수 있으니 7번으로 가요.

4. `list_sessions` 를 한 번 부르고, 결과 JSON 을 **고치거나 뽑지 않고 그대로** 임시 json 파일로 저장한 뒤 `--rows --titles <그 파일>` 로 3번을 다시 실행해요. 스크립트는 현황판 행의 sid(대화 기록 파일 id)와 **id 필드가 정확히 같은** 항목만 짝으로 써요. 폴더·시간·제목이 비슷하다고 짝을 지어 주지 않아요(이 세션도 짐작해서 고치지 않아요). 짝이 없는 행의 세션 제안은 조언 전용(`advice_only`, `unmapped`)으로 나가고 적용되지 않아요. 제목 마스킹은 설정(`dashboardMaskTitles`)이 정해요.

5. 기존 문서 버전이 필요해요(있는 문서는 `if_version` 없이 못 써요). `ArtifactData list` 를 `collection` = `sessions`, `account`, `summary` 로 각각 부르되 `out_dir` 를 같은 폴더(`<임시>/versions`)로 줘요. 그다음 `--rows --versions <임시>/versions` 로 3번을 다시 실행해요(첫 게시라 문서가 없으면 이 5번은 건너뛰어요).

6. 3번 출력의 `writes` 배열을 **그대로** `ArtifactData` `action:"batch"` 의 `writes` 로 넘겨요(`url` = `dashboardUrl`). 순서·인자를 바꾸지 않아요. 각 항목의 `file_path` 가 데이터 파일이에요. 실패하면(예: 버전 충돌) 결과를 그대로 한 줄 보고하고 다음 회차로 넘겨요. 직접 고쳐 쓰지 않아요.

7. 결정 읽기(제안·승인·설정 고리). 이 단계부터는 `url` = `dashboardUrl`, 파일은 `out_dir` 로 `<임시>/apply` 폴더에 저장해요.
   - `ArtifactData query` `collection`=`decisions` 를 `status`=`approved` 로 한 번, `status`=`held` 로 한 번 불러요(결과를 각각 `<임시>/apply/decisions-approved.json`, `decisions-held.json` 으로 저장하고 두 배열을 `<임시>/apply/decisions.json` 하나로 합쳐요. 합치기는 이어 붙이기만 해요).
   - 제안 문서(`proposals`)는 읽지 않아요. 제안 내용(종류·대상·값·근거·보호)은 3번이 이 PC 에 남긴 사본만 쓰고, 결정 문서에서는 상태·결정자·결정 시각만 읽어요. 이 PC 사본에 없는 pid 는 `unknown_proposal` 로 거절돼요.
   - `ArtifactData get` `collection`=`settings`, `doc_id`=`requested` → `<임시>/apply/settings.json`(없으면 이 파일 없이 가요).
   - approved·held 결정이 하나도 없고 `settings/requested` 도 없으면 "적용할 결정 없음" 한 줄만 알리고 12번으로 가요.

8. 4번에서 저장한 `list_sessions` 결과를 그대로 `<임시>/apply/live.json` 으로 써요(고치지 않아요). 4번을 못 했으면 승인된 세션 대상 결정마다 `get_session`(그 sid)을 불러 결과를 고치지 않고 배열로 모아요. 짝은 id 필드가 정확히 같을 때만 지어지고, 실패했거나 짝이 없는 대상은 스크립트가 `unmapped` 로 거절해요. 제목도 폴더도 없는 항목은 보호 대상으로 거절돼요. 대상이 이 세션 자신이어도 그대로 넘겨요(거절은 스크립트가 해요).

9. 실행 세션 자신의 sid(`--self`)는 현황판 행과 같은 종류의 id, 즉 이 세션 대화 기록 파일 이름(확장자 뺀 부분)이에요. 모르면 `--self` 를 빼요. 그다음 실행해요.
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.js" --apply --decisions <임시>/apply/decisions.json --settings <임시>/apply/settings.json --live <임시>/apply/live.json --self <이 세션 sid>`
   (없는 파일의 플래그는 빼요. `--proposals` 는 더 이상 쓰지 않아요.) 출력 JSON 은 `{ops, buttons, results, settings_applied, apply_mode, apply_mode_next, batch}` 예요. 가부 판정(짝 확인·보호·스테일·지금 등급·판단 예외·대상 변경·상한·세션당 1건)은 전부 스크립트가 끝냈으니 이 세션은 다시 따지지 않아요. 설정에서 바꾼 적용 모드는 다음 회차부터 적용돼요(`apply_mode_next`). 한 회차 적용은 최대 3건(`applyMaxPerRun`)이고 스크립트가 이미 제한해요.

10. `ops` 와 `buttons` 를 실행해요. 판단하지 않아요.
    - `ops` 의 각 항목을 **배열 순서대로, 인자 그대로** `set_session_model`(`args` 를 그대로) 호출해요. 값 바꾸기·합치기·건너뛰기 금지. 성공하면 `{"pid": <pid>, "ok": true}`, 도구 오류면 `{"pid": <pid>, "ok": false, "reason": "tool_error"}`, 예상 밖 응답(성공도 오류도 아닌 모양, 다른 모델로 바뀜 등)이면 `{"pid": <pid>, "ok": false, "reason": "unexpected_tool_result"}` 로 적고 **스스로 고치거나 재시도하지 않고** 다음 항목으로 가요. 결과 배열을 `<임시>/apply/results.json` 에 저장해요.
    - `buttons` 의 `offer_clear` 항목은 이 세션이 실행하지 않아요. 끝에 `wrap_up` 카드의 버튼으로만 띄워요("<제목 또는 sid 앞 8자> 비우기 — 되돌릴 수 없어요, 인계 메모가 있어요"). `clear_session` 은 직접 호출하지 않아요(오너가 버튼을 눌렀을 때 앱 동작으로만 일어나요). 버튼은 결과 배열에 넣지 않아요.

11. `ops` 가 있었으면 `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.js" --record-apply --results <임시>/apply/results.json` 을 실행하고, 출력의 `batch.writes` 를 **그대로** 합쳐요: 9번 출력의 `batch.writes` + 11번 출력의 `batch.writes`(9번은 거절·만료·설정 반영, 11번은 적용·실패 결과). 합친 배열이 비어 있지 않으면 `ArtifactData` `action:"batch"` 의 `writes` 로 한 번에 넘겨요(`url` = `dashboardUrl`). 실패하면 결과를 그대로 한 줄 보고하고 다음 회차로 넘겨요. 직접 고쳐 쓰지 않아요.

12. 비용 측정 후: `get_usage`(self) 의 Messages 토큰 `T1` 로 `N = T1 − T0` 를 구하고 `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.js" --record-push tokens=N rows=M`(M = 출력의 `rows`)을 실행해요. `T0`/`T1` 이 없으면 `tokens=` 는 빼요(추정하지 않아요). 6번 batch 가 성공했을 때만 실행해요(3번에서 건너뛰었으면 실행하지 않아요).

13. 끝에 한 줄: 몇 행을 갱신했는지. 그리고 "15분마다 자동으로 하려면 `/loop 15m /token-stamina:board`" 를 한 줄 안내해요(이미 loop 로 돌고 있으면 생략).

이 명령은 `~/.claude/projects` 를 쓰지 않고, 지표를 외삽하지 않아요.
