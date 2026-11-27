# Real-time notifications (customers)

For web and mobile client developers. The server pushes events over
[Socket.IO](https://socket.io/docs/v4/) (server 4.8). Use the official client:
`socket.io-client` 4.x for web and React Native.

**REST stays the source of truth.** An event tells you that something changed.
Refetch over REST to get the data, rather than building state from events. If
you miss an event (offline, reconnecting), nothing is lost: the bell API has
everything.

## Connecting

| | |
| --- | --- |
| URL | The API origin, without `/api/v1`, plus the namespace: `https://api.example.com/user` |
| Path | `/socket.io` (the default) |
| Auth | `auth: { token: <access token> }`. `Authorization: Bearer` also works. Never put it in the query string. |
| Who | Any signed-in customer, including before onboarding is finished |

```ts
import { io } from 'socket.io-client';

const socket = io(`${API_ORIGIN}/user`, {
  // A function, so every reconnect sends the current token.
  auth: (cb) => cb({ token: getAccessToken() }),
  transports: ['websocket'], // React Native: websocket only
});
```

- **Web:** keep one connection per tab, opened after sign-in and closed on sign-out.
- **Mobile:** connect while the app is in the foreground. When it comes back, reconnect and refetch the unread count.
- At most **20 connections per customer** are allowed. Anything beyond that is refused with `RATE_LIMITED`.

## Refused connections (`connect_error`)

`err.message` is readable text, and `err.data.code` is the same error code the REST API uses:

| `err.data.code` | What to do |
| --- | --- |
| `ACCESS_TOKEN_EXPIRED`, `ACCESS_TOKEN_INVALID` | Refresh the access token (the normal refresh call), then `socket.connect()`. |
| `UNAUTHENTICATED` | No token was sent. Connect only after sign-in. |
| `SESSION_REVOKED`, `SESSION_EXPIRED`, `ACCOUNT_DISABLED` | The session is over. Do not retry; go to sign-in. |
| `RATE_LIMITED` | Too many open connections. Close unused ones. |
| `INTERNAL_ERROR` | Retry with backoff. |

## Events from the server

Clients send no events.

| Event | Payload | What to do |
| --- | --- | --- |
| `notification:new` | `{ notification }` (shape below) | Refetch the bell (`unreadCount` and list). For `type: "risk_notice.required"`, also refetch `GET /users/me`: `requirements.riskNoticeRequired` becomes `true`, so send the user to the risk notice screen. |
| `notification:read` | `{ unreadCount }` | Notifications were marked read, possibly on another device. Update the badge. |
| `auth:expired` | none | The token this connection was opened with has expired, and the server disconnects right after. Refresh the token, then `socket.connect()`. |
| `session:revoked` | `{ reason }` | This session was signed out (logout, sign out everywhere, password change, account blocked). The server disconnects right after. **Do not reconnect**; clear the session. |

The `disconnect` reason tells you what happened:

| Reason | Meaning | Socket.IO reconnects by itself? |
| --- | --- | --- |
| `io server disconnect` | The server ended this connection on purpose, always right after `auth:expired` or `session:revoked`. | No. Reconnect yourself after `auth:expired`; never after `session:revoked`. |
| `transport close`, `ping timeout`, `transport error` | Network loss, or the server restarting or being deployed. | Yes, with backoff. When `connect` fires again, refetch the unread count. |

## Notification shape

The same shape is used over REST and over the socket:

```json
{
  "id": "uuid",
  "type": "risk_notice.required",
  "title": "Your risk limits have changed",
  "body": "Adviserz has updated the limits for Equity Intraday. Please review and accept them to continue.",
  "link": "/risk-notice",
  "data": { "segmentId": "uuid", "segmentCode": "EQUITY_INTRADAY", "version": 3 },
  "readAt": null,
  "createdAt": "2026-11-23T10:00:00.000Z"
}
```

- Show `title` and `body` as they are. They are stored exactly as sent.
- `link` is a web path. Mobile apps map it to their own screen; for example, `/risk-notice` is the risk notice screen.
- Types today: `risk_notice.required`, sent when an admin changes risk limits the customer must accept. It is marked read automatically once the customer accepts the notice, or when the limits are changed back to ones the customer already accepted (then there is nothing left to accept). Either way, open devices get `notification:read`.

## Bell API (REST)

All endpoints need the customer access token. They are always available, even while a pending risk notice or policy blocks other features.

| | |
| --- | --- |
| `GET /api/v1/users/me/notifications?page=&pageSize=` | Newest first. Returns `{ items, unreadCount, pagination }`. `pageSize` is at most 100. |
| `GET /api/v1/users/me/notifications/unread-count` | `{ unreadCount }` |
| `POST /api/v1/users/me/notifications/read` `{ ids: [uuid] }` | Ignores ids that are not the user's or are already read. Returns `{ updated, unreadCount }`. |
| `POST /api/v1/users/me/notifications/read-all` | `{ updated, unreadCount }` |

## Server notes

- **Code:** `src/modules/realtime/` holds the socket server, the handshake check and the only send helpers (`emitToUser`). `src/modules/notifications/` holds the bell.
- **Saving and pushing:** services save notifications inside their transaction. The push happens only after commit (`afterCommitPush`), so a rolled-back change never notifies anyone.
- **Sign-outs:** every place that revokes a session (`session.service.ts`) also closes that session's sockets.
- **More than one API server:** add the Socket.IO Redis adapter in `realtime.server.ts`. If clients may fall back to HTTP long-polling, also enable sticky sessions on the load balancer.
- **Reverse proxy:** it must allow WebSocket upgrades on `/socket.io/`.
