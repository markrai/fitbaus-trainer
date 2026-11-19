# Connect YouTube to FitBaus Bike Bridge

FitBaus Full can browse your Google account's **YouTube subscriptions,
subscribed-channel uploads and playlists** on the ProForm Smart Power 10.0
console (Android 5.1.1). Google sign-in is approved on your **phone or PC**,
not by typing your Google password on the bike.

This does **not** replicate the personalized YouTube Home feed, Watch History
or Watch Later. Those are not available through the public YouTube Data API.
The selected video is still played using FitBaus's native NewPipe/ExoPlayer
player, so private or account-restricted videos may not play.

The account feature requires a **FitBaus Full Bike Bridge APK that includes
Google OAuth support**. Merely checking out an updated repository does not
upgrade an APK already installed on the bike.

## What you need

- Your own Google Cloud project and a Google account that uses YouTube.
- A phone or PC signed into that account for the Google verification step.
- A compatible Bike Bridge installation. The standard Trainer web/PWA is
  not the Bike Bridge app.
- For the recommended Windows import: Android SDK Platform Tools
  (`adb.exe`), an authorized ADB connection to the console, and this
  repository checkout. Manual entry on the bike is also possible.

Create **your own** Google OAuth client. Never post your downloaded client
JSON, client secret, or access tokens in issues, logs, or screenshots.

## 1. Enable YouTube Data API v3

1. Open [Google Cloud Console](https://console.cloud.google.com/) and use the
   top project selector to **create or select a project**.
2. Go to **APIs & Services → Library** or open the
   [YouTube Data API v3 entry](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Select **Enable**. Check **APIs & Services → Enabled APIs & services**
   to verify that YouTube Data API v3 appears **in the same project**.

An **API key** or service account JSON is not enough. This feature needs
OAuth credentials for a Google user.

## 2. Configure Google Auth Platform

This is where older Google Cloud tutorials, and our initial setup directions,
were confusing. The interface may say **Google Auth Platform**, rather than
just **OAuth consent screen**, and its pages may be split into **Branding**,
**Audience**, **Data Access** and **Clients**.

1. In the Cloud Console, open **Google Auth Platform**. The older route
   **APIs & Services → OAuth consent screen** may take you there.
   For a new project, select **Get started** and complete initialization.
2. In **Branding**, enter a descriptive app name (for example,
   `FitBaus Bike Console`), a user-support email, and the requested
   developer contact email. Complete the required fields and save.
3. Under **Audience**, select **External** for an ordinary personal Google
   account. **Internal** is intended for eligible Google Workspace
   organizations.
4. If the OAuth app is in **Testing**, add the **exact Google account**
   you will authorize under **Audience → Test users**, then save.
5. Open **Data Access → Add or Remove Scopes**. Select or manually add:

   ```text
   https://www.googleapis.com/auth/youtube.readonly
   ```

   Save the scope selection. This gives FitBaus read-only access to
   YouTube account resources, not permission to change your account.

**Hiccup: the old scope URL says “page not found.”** Don't rely on an
outdated, deep-linked scope URL. Navigate through **Google Auth Platform →
Data Access → Add or Remove Scopes** in the selected project. If you do
not see Google Auth Platform in the menu, try **APIs & Services → OAuth
consent screen**, or search the Cloud Console for **OAuth consent screen**.
Check that you are in the correct project.

**Hiccup: the scope doesn't appear.** Confirm that YouTube Data API v3
is enabled **in this same project**. Google also allows manually adding
an unlisted scope from Data Access.

## 3. Create the correct OAuth client

1. Go to **Google Auth Platform → Clients → Create client**. Depending on
   the current UI, the alternate route is **APIs & Services → Credentials →
   Create Credentials → OAuth client ID**.
2. Set **Application type** to **TVs and Limited Input devices**.
   Give it a recognizable name and create it.
3. Download the client JSON to your PC. You need the **installed** object
   containing **client_id** and **client_secret**, for example:

   ```json
   {
     "installed": {
       "client_id": "EXAMPLE.apps.googleusercontent.com",
       "client_secret": "EXAMPLE-DO-NOT-USE"
     }
   }
   ```

   The example is illustrative, not a usable credential. Use Google's
   actual downloaded file unchanged. Do **not** rename it to a required
   filename: the import script accepts any single `.json` file.
4. Do **not** choose Web application, Android, Desktop, API key, or service
   account. The Bike Bridge implements Google's limited-input device flow,
   not an embedded browser redirect.

For Google documentation, see
[OAuth 2.0 for TVs and Limited Input Devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
and [Google Auth Platform setup](https://support.google.com/cloud/answer/15544987).

## 4. Recommended: import the downloaded JSON using Windows + ADB

The root repository contains `push_youtube_auth.bat`, which calls
`scripts/push-youtube-auth.ps1`.

1. In your FitBaus checkout, create the folder
   `secrets\youtube\`, if it does not already exist. Put **exactly one**
   downloaded Google OAuth `.json` file in that folder. The whole
   `secrets/` directory is ignored by Git, except its placeholder file.
2. Connect the bike using ADB. First identify the **actual** current ADB
   serial or IP. Do not assume the default IP in the script matches yours:

   ```powershell
   adb devices -l
   adb connect 192.168.1.200:5555
   adb -s 192.168.1.200:5555 get-state
   ```

   Substitute your real bike address. The last command must output
   `device`. If you use USB rather than TCP, use the serial shown by
   `adb devices -l`.
3. Check that the appropriate **OAuth-enabled** Bike Bridge APK is already
   installed. In particular, staging and production have **different
   package IDs**.
4. Run this from the **repository root**:

   ```bat
   push_youtube_auth.bat 192.168.1.200:5555 production
   ```

   Or, for a staging install:

   ```bat
   push_youtube_auth.bat 192.168.1.200:5555 staging
   ```

   Replace the address with yours. You may instead set
   `FITBAUS_BIKE_ADB` to your ADB device identifier. Calling the script
   with no arguments defaults to `192.168.1.226:5555`, which may not
   be your console's current address.
5. The helper checks the file's `installed.client_id` and
   `installed.client_secret`, verifies the target and installed app,
   transfers the JSON to a temporary app-specific directory, invokes
   the nonce-scoped importer, and removes temporary files. Successful
   import prints **“Credentials imported and encrypted on the bike.”**
6. **Import is not authorization.** Look at the bike's **YouTube**
   screen. Google presents a verification URL and user code. Open the
   URL on your phone/PC, choose your YouTube account, enter the code,
   and approve the requested **YouTube read-only** access.

The script does not take the JSON contents or secret as command-line
arguments. Nevertheless, the JSON exists briefly in Android 5.1's
**app-specific external storage**, which can be read by other apps with
broad storage permission. Use a trusted console and ADB connection.
The importer deletes its staging copy; safely retain or delete the
original on your PC according to your credential management needs.

### Alternative: manual entry on the bike

If you prefer not to use ADB, open **YouTube → MY YOUTUBE → CONNECT
GOOGLE**, and type/paste the **TV client ID** and **client secret** from
Google Cloud. Select **Start**, then approve the Google device code using
your phone or PC. This enters the same authorization flow.

## 5. Verify it works

After approving, **MY YOUTUBE** should show **SUBSCRIPTIONS** and
**PLAYLISTS**. Select a channel to see its recent uploads or open a
playlist to choose a video. **BROWSE** returns to FitBaus's unauthenticated
search and Trending view.

FitBaus stores its client secret and refresh token encrypted in app-private
preferences using an Android Keystore-backed key. Access tokens are
kept in memory. **SIGN OUT** clears local authorization and requests
Google-side token revocation; you can additionally revoke access from
your Google Account security settings.

## Troubleshooting

| Symptom | Check or resolution |
| --- | --- |
| The Google Auth Platform menu or scope page is missing | Open **APIs & Services → OAuth consent screen**, then **Data Access → Add or Remove Scopes**; confirm the active Cloud project |
| `youtube.readonly` isn't offered | Enable **YouTube Data API v3** in the same project; use the manual scope entry in Data Access if needed |
| “Access blocked”, “test user”, or `access_denied` | Ensure **External / Testing** is configured and your phone's exact Google account is an authorized **test user**; make sure you're authorizing the intended account |
| `adb.exe: device 'IP:5555' not found` | Run `adb devices -l`, reconnect to the console's **current** IP/port, and check `adb -s IP:5555 get-state`. A previously used address may have changed |
| “Expected exactly one .json file” | Keep **one** Google client JSON in `secrets\youtube\`; remove duplicates from that folder |
| “JSON must contain an installed TV OAuth client_id and client_secret” | Download the **TVs and Limited Input devices** OAuth JSON; an API key or other client type is not a substitute |
| “The selected FitBaus app is not installed” | Install the OAuth-enabled APK; choose **production** for `com.fitbaus.bikebridge` or **staging** for `com.fitbaus.bikebridge.native` |
| The output says `1 file pushed, 0 skipped` and then `ERROR` | ADB has **successfully transferred** the file. Older `push-youtube-auth.ps1` revisions treated normal ADB transfer progress on stderr as a PowerShell error. Update the helper to the version that checks ADB's **exit code** independently of its output, and retry; the Google client JSON itself does not need to be regenerated |
| “No import acknowledgment” | Verify an OAuth-enabled Bridge APK is installed, the selected package matches, and the app can open on the bike. Retry after confirming connectivity |
| The bike shows a code, then fails after 3–5 seconds | That aligns with the **first token poll**, not the normal code expiry. Google requires both `client_id` **and** `client_secret` when polling, whereas requesting the code requires only `client_id`. With a Bridge build containing OAuth diagnostics, inspect the on-bike failure message before changing credentials. |
| `invalid_client (HTTP 401)` during token polling | Confirm that the downloaded JSON is from a **TVs and Limited Input devices** OAuth client and that `installed.client_id` and `installed.client_secret` are from the **same** Google Cloud OAuth client. Re-import that matching JSON if needed. Do not paste the secret into bug reports. |
| `unsupported_grant_type (HTTP 400)` or `invalid_grant (HTTP 400)` | The token request or device code was rejected. Confirm that the installed Bike Bridge build supports the limited-input device flow; request a fresh device code if it has expired or was already used. |
| A code appears and says “Google rejected token polling: ...” | Follow the **safe OAuth identifier and HTTP status** on the bike. Normal `authorization_pending (HTTP 428)` is not a failure and should keep the code visible. The `slow_down` response requests a longer delay, not a new code. |
| “Network or TLS error during token polling” | Check the bike's **internet access, clock/date and TLS trust**, not the Trainer-to-Bike local HTTP connection. The bike connects directly to `https://oauth2.googleapis.com/token`. |
| “FitBaus could not read or save encrypted Google credentials” after a code appears | This is a **local** Android Keystore/credential round-trip error, not evidence that Google refused the code. Install an APK with the API-22 Keystore correction and run `push_youtube_auth.bat` again using the same TV OAuth JSON. Do not reset the bike or clear app data. |
| “credential storage failed at RSA key unwrapping” or another named stage | FitBaus now identifies which **local cryptographic stage** failed without revealing secrets. Check that the OAuth-enabled APK is updated and that the app's Android Keystore entry is accessible; record only the stage name for a bug report. Do not delete Keystore aliases or wipe app preferences. |
| “unexpected response” or “encrypted Google credentials” | The failure is likely local response parsing or Android Keystore storage, respectively. Reinstall a build with the diagnostic fix and reproduce before changing Google Cloud settings. |
| A code appears but login fails or expires | Approve it on the same Google account listed as a test user. Restart authorization to obtain a fresh code; an expired code cannot be reused |
| Sign-in works, then expires after about seven days | External OAuth apps left in **Testing** generally issue refresh tokens that expire after seven days for YouTube scopes. Consider Google's production verification requirements before distributing to others |
| Personal playlists are blank | Verify you've selected the correct Google/YouTube account or channel; Google only returns the authorized account's available lists |
| A selected private video doesn't play | Google OAuth authorizes Data API browsing, **not** NewPipe playback. The native player cannot necessarily play account-restricted videos |

**Security:** Never commit `secrets/youtube`, copy OAuth JSON into the APK,
post bearer tokens in issue reports, or expose the Bridge's ADB endpoint
to the internet. For public distribution, follow Google's API Services
and OAuth verification policies; a personal Testing setup is not public
production approval.

## Android 5.1 Keystore compatibility

FitBaus stores the Google TV client secret and OAuth refresh token encrypted
with AES-GCM. On Android 5.1 (API 22), the AES key is wrapped by an
Android Keystore RSA keypair. The corrected implementation explicitly
selects the platform's legacy `AndroidOpenSSL` provider for RSA operations
on API 22 and earlier, and uses an explicit 12-byte AES-GCM nonce for
new ciphertext.

Before presenting Google's verification code, the console now verifies
that it can encrypt, persist and **reload/decrypt** the TV client secret.
If this fails, it shows a safe credential-storage stage rather than a
Google authorization code that would fail on its first poll.
The old wrapped AES key and Keystore RSA alias are **retained**. The decoder
also supports older ciphertext with 12- or 16-byte GCM nonces without
silently accepting a bad authentication tag.

To retry after installing the corrected Bridge APK, run
`push_youtube_auth.bat` again with your existing TV OAuth JSON, or
enter the same client details manually. You do **not** need a new
Google Cloud OAuth client. Do not uninstall the Bridge APK, wipe
app data, regenerate Keystore keys or clear pairing to diagnose this.
If the console still reports an RSA or AES failure, the device-specific
provider behavior needs physical inspection; CI can test the ciphertext
format but cannot reproduce the console's hardware-backed Keystore.

## Why the first poll can fail

Google's device authorization flow first asks for a display code using only
the OAuth **client ID**. Five seconds later (or after the server's specified
polling interval), the bike makes a different request to exchange that code
for tokens. This second request includes **both client ID and client secret**.

Getting a visible code therefore confirms that the initial request succeeded;
it does **not** prove that the client secret will be accepted by the token
endpoint. Google's documented `invalid_client` response is HTTP 401, and
can indicate a mismatched secret or incorrect OAuth client type.

Before approval, Google normally responds with `authorization_pending`
(HTTP 428) and the app must keep polling. The bike's local HTTP Bridge URL
is unrelated: Google OAuth requests use direct **HTTPS** connections.

The updated Bike Bridge shows only a fixed, safe OAuth error identifier and
HTTP status, or a generic local error category. It deliberately does not show
or log raw Google responses, `error_description`, secrets or tokens. If your
installed APK predates this change, it may still say only "Google sign-in
failed" even when the actual cause is known to Google.

## References

- [Google OAuth for TVs and limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Google Auth Platform setup](https://support.google.com/cloud/answer/15544987)
- [Google Data Access and scopes](https://support.google.com/cloud/answer/15549135)
- [Google OAuth client management](https://support.google.com/cloud/answer/15549257)
- [FitBaus YouTube implementation notes](../equipment-bridges/proform-smart-power-10/docs/YOUTUBE-INTEGRATION.md)
