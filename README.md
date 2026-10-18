# DineFlow Restaurant Management System — Backend Edition

## Start

1. Install Node.js 24 or later.
2. Double-click **START DINEFLOW.bat**, or run `npm ci` followed by `npm start` in this folder.
3. Open http://127.0.0.1:4173 and complete **Create Administrator** with your own name, email, and a password of at least 12 characters. There is no default password.
4. The optional reference-catalog checkbox creates the six menu items and ten tables from the supplied designs. It creates no fake customers, sales, or receipts. Add your customers and orders through the application.

SQLite creates `data/dineflow.sqlite` automatically. All restaurant and account records now belong to the server database rather than a browser. Keep the `data` directory when upgrading. The original page folders, styles, colors, assets, and responsive layouts are retained; `reset-password/` adds the password-selection screen using the existing modal styling.

## Create and connect the Gmail sender

1. Double-click **CREATE GMAIL ACCOUNT.bat** to open Google's signup page. You must supply your own personal details, choose an available address, enter the password, complete any Google verification, and accept Google's terms yourself. No Gmail account has been created automatically.
2. Enable Google 2-Step Verification, then create a Google App Password for DineFlow. See [Google's instructions](https://support.google.com/accounts/answer/185833) and [App Passwords](https://myaccount.google.com/apppasswords). Some account security configurations do not permit App Passwords.
3. Double-click **CONFIGURE GMAIL.bat**. Enter the new `@gmail.com` address and its App Password in the terminal. Password entry is hidden. The launcher verifies Gmail's SMTP connection before saving `.env` privately.
4. Restart DineFlow. SMTP uses `smtp.gmail.com`, port `465`, and TLS. Your regular Google password is not used.

Alternatively, copy `.env.example` to `.env` and fill in `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`. Do not put the App Password in chat, frontend files, Git, or a shared ZIP. A reset link can only reach another device if `APP_URL` is reachable from that device; the default loopback URL works on the server computer.

Live Gmail delivery cannot be verified until you finish the account and App Password setup. Missing or failing SMTP produces an explicit error; the application does not claim an email was delivered.

## Account and restaurant workflows

- **Login:** server-verified scrypt password hashes, HttpOnly/SameSite cookies, 12-hour sessions, login throttling, CSRF and origin checks, and protected pages/API routes. Password and reset-token changes revoke sessions. Browser code contains no password database.
- **Account requests:** submit from Contact Admin. An administrator opens **Settings → Account → Account Requests**, chooses Staff or Admin access, and approves or rejects the request. Approval emails a one-use, 24-hour invitation. The recipient chooses their own password. Failed invitations can be resent. Requested job titles never grant access automatically.
- **Password reset:** Forgot Password emails a one-use link that expires in one hour. Passwords require 12–128 characters. Expired, used, or invalid tokens are rejected. Tokens are stored only as hashes.
- **Customers, menu, and tables:** database-backed create/edit/search/filter actions. Customer and menu deletion archives the record, preserving order and receipt history. Version checks reject stale updates from another session.
- **Orders:** prices and item names are snapshotted at creation. Catalog price changes cannot silently alter existing orders. Invalid/unavailable items are rejected. Closed orders cannot be edited. Tables remain occupied while any of their orders are open.
- **Billing:** open an order's Edit dialog and choose Proceed to Billing. Mark it Served before payment. The server calculates subtotal, VAT at the reference rate of 12%, and total in integer centavos. Receipt creation is atomic and idempotent, preventing double payment. Customer visits, table status, and reports update together. Transactions and receipts are immutable snapshots.
- **Card and GCash:** record a payment already completed through your external terminal or merchant account, with its payment reference. This integration does not charge cards or connect to GCash's payment gateway.
- **Reports:** totals and the seven-day revenue chart use actual database records in the configured restaurant timezone. Click a transaction ID to open its receipt. CSV export protects against spreadsheet formula injection. Empty databases show zero sales rather than the reference screenshots' demonstration totals.
- **Settings:** administrators manage restaurant details and user access. Staff can manage customers, orders, and table states but cannot change catalog prices, create tables, approve accounts, or manage other users. Password and display/printing/email preferences are per account; restaurant contact email is separate from each person's login email.
- **Daily email reports:** enabled accounts receive the previous day's closing report after 00:05 in `RESTAURANT_TIMEZONE`. The server must be running. Delivery is deduplicated in SQLite; failures retry at most three times with an hour between attempts. Auto-print opens the browser print dialog; it does not bypass printer permissions.

The previous frontend's localStorage records remain in the original browser but are not automatically trusted/imported as real sales. The new database starts without financial history. The optional reference catalog provides menu/table starting data only.

## Verification and backup

- `npm test`: HTTP integration tests against temporary databases, frontend page/form checks, permissions, token expiry/reuse, failed email delivery, immutable receipts, payment retries, and restart persistence.
- `npm run backup`: creates a consistent SQLite backup in `backups/` while the app is running. Back up `.env` securely and separately. To restore, stop DineFlow and restore a backup as `data/dineflow.sqlite`; preserve the old database and any WAL/SHM companions together before replacing them.
- `node tests/preview.cjs`: disposable in-memory UI verification on `http://localhost:4180`. This test server uses only synthetic accounts/records and an email stub, never your real restaurant database or Gmail. The test credential is documented inside that test fixture only.

## Hosting

This is a running Node/SQLite backend, not a static HTML deployment. Use one server process with persistent storage for the database. Default binding is loopback. For LAN/public deployment, configure an HTTPS reverse proxy, a reachable HTTPS `APP_URL`, `COOKIE_SECURE=true`, a long random `SETUP_SECRET`, and the correct `HOST`/`PORT` in `.env`. Complete first-time setup before exposing the application. SMTP sends links using `APP_URL`, never an untrusted request Host header. Protect the server account and backups with OS access controls. Source files, `.env`, database files, and backups are excluded from the HTTP file allowlist.

Design limitation retained from the original delivery: the login illustration and food thumbnails were extracted from the supplied screenshots; the login art includes its original branding/text as a single image.
