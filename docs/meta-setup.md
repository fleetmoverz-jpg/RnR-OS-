# Facebook Pages and Instagram publishing: setup

RnR Os publishes to Facebook Pages and Instagram professional accounts through Meta's official Graph API. It uses Facebook Login, and it never asks for or stores a password. Tokens are encrypted with AES-256-GCM, stored in server-only tables, and never sent to the browser.

**Real publishing works only after every step below is done.** Until then, the Connected Accounts page explains what is missing, and the Publish button refuses to run.

## 1. Create the Meta app

1. Go to https://developers.facebook.com/apps → **Create app**.
2. Choose the **Business** app type, or use the "Manage everything on your Page" and "Manage messaging & content on Instagram" use cases.
3. Connect the app to your Business portfolio.
4. Add the **Facebook Login for Business** product.
5. Under **Facebook Login → Settings**, set **Valid OAuth Redirect URIs** to:

   ```
   https://rn-r-os.vercel.app/api/social/meta/callback
   ```

   Keep "Client OAuth login" and "Web OAuth login" on, and turn "Enforce HTTPS" on.
6. Under **App settings → Basic**, copy the App ID and App Secret. Also add a Privacy Policy URL and app icons, which app review requires.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value |
| --- | --- |
| `META_APP_ID` | App ID from step 1 |
| `META_APP_SECRET` | App Secret from step 1. Server-only, never exposed to the browser |
| `TOKEN_ENCRYPTION_KEY` | Already needed for Google. 32 random bytes: `openssl rand -base64 32` |
| `META_GRAPH_VERSION` | Optional. Defaults to `v26.0`. Set it when Meta retires a version |

Redeploy after you change these.

## 3. Permissions RnR Os asks for

These are the only permissions the app requests:

| Permission | Why |
| --- | --- |
| `pages_show_list` | List the Pages you manage so you can choose one |
| `pages_manage_posts` | Create posts on those Pages |
| `pages_read_engagement` | Read reactions, comments and shares on posts the app made |
| `instagram_basic` | Read the linked Instagram account's username and posts, to confirm publication and read like/comment counts |
| `instagram_content_publish` | Publish images to the Instagram professional account |

Notes:
- If a Page is owned by a Business portfolio and you reach it only through Business Manager, Meta may also require `business_management`. In that case, assign yourself to the Page directly instead.
- An Instagram account must be a **Business or Creator** account and must be **linked to a Facebook Page**. Personal Instagram accounts can't publish through the API.
- Accounts get only the actions Meta actually allows them: the granted permissions plus your tasks on the Page (CREATE_CONTENT or MANAGE). The Connected Accounts page lists these per account.

## 4. App review and access levels

- In **Development mode**, the app works only for people with a role on the app (admin, developer or tester), and only on Pages they manage. That is enough for you to test with your own Pages.
- To publish for Pages whose managers have no role on the app, Meta requires **Advanced Access** for each permission above. Getting it takes:
  1. **Business verification** of your Business portfolio.
  2. **App Review**. For each permission, submit a screencast showing the flow: connect, choose a Page, approve a draft, press Publish, and see the post on Facebook or Instagram. Add a short explanation of why the permission is needed (use the table above).
  3. Switch the app to **Live** mode.
- Meta also requires that Pages needing Page Publishing Authorization have completed it.

## 5. Limits RnR Os respects

- Instagram allows 100 API-published posts per account per 24 hours. RnR Os checks `content_publishing_limit` before each post.
- When Meta reports usage near the limit (X-App-Usage / X-Business-Use-Case-Usage headers) or returns a rate-limit error, the account is paused until Meta says it is safe.
- Instagram images must be JPEG at a public https URL, at most 8 MB, with a shape between 4:5 and 1.91:1. RnR Os fetches the image through its network guard and checks it again right before publishing.

## 6. How a publish works

1. An admin presses **Publish now** on an approved post version that has an account chosen.
2. The app checks everything first: approval, content validation, the account's status, permissions and rate limit, and the image. If anything fails, nothing is sent.
3. One job per version and account, with an idempotency key, means a double click or a retry can never post twice.
4. The post counts as **published only when Meta returns the post id**. The id and link are stored.
5. If Meta's answer is unclear (a timeout or a server error while posting), the job becomes **Needs check** and is never retried automatically. **Check if it posted** looks for the post on the Page or Instagram account. If found, the post is marked published. If it is still missing after two minutes, it is safe to try again.
6. An expired token marks the account **Needs reconnect**. Publishing never switches to another account or brand.

## 7. Manual test checklist (with a test Page)

- [ ] Connected Accounts shows "Ready" for Facebook Page and Instagram after the env vars are set.
- [ ] **Connect Facebook** opens Facebook's dialog listing only the five permissions above.
- [ ] Cancelling the dialog returns with "Facebook sign-in was cancelled".
- [ ] After approving, your Pages and linked Instagram accounts are listed. Add one Page and its Instagram account to a brand.
- [ ] Each account shows its permitted actions. **Check** reports "Working".
- [ ] In Content Studio, approve a draft with a Facebook version, choose the Page, then press **Publish now**. The post appears on the Page and the **View** link opens it.
- [ ] Press **Publish now** again on the same version. It reports "Already published" and no second post appears.
- [ ] Add a non-JPEG or a very tall image to an Instagram version. Publishing is refused with the reason.
- [ ] Add a valid JPEG link, re-approve, then publish to Instagram. The post appears and the link works.
- [ ] **Get metrics** shows reactions and comments. Hidden like counts show as "unavailable".
- [ ] Remove the app in Facebook → Settings → Business integrations, then press **Check**. The account turns **Needs reconnect** and Publish is refused.
- [ ] **Disconnect & revoke** removes all accounts from that login. Facebook no longer lists the app.
- [ ] Publishing History lists every attempt with Meta's answer and no tokens.

## Not supported

- **Medium**: Medium no longer issues API access to new integrations, so RnR Os does not offer Medium publishing.
- X, LinkedIn, Google Business Profile, Threads, Pinterest and WordPress are planned as later adapters. They are shown as "Later" and cannot publish.
