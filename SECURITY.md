# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

이 레포는 라이브러리입니다. 지원 대상은 최신 릴리스입니다. 트랜스포트는 설정한 AG-UI 서버 주소로만 요청을 보내며, `headers` 에 넣은 값(예: 인증 토큰)은 그 서버로 전달됩니다. 신뢰하는 서버 주소만 쓰세요. 연습용 목 서버(`agui-chat-transport/testing`)와 예제는 내 컴퓨터(127.0.0.1)에서만 접속되도록 되어 있습니다.

This repository is a library. The latest release is the supported version. The transport only sends requests to the AG-UI server URL you configure, and values you put in `headers` (for example auth tokens) are sent to that server, so use only servers you trust. The practice mock server (`agui-chat-transport/testing`) and the examples only listen on your own machine (127.0.0.1).
