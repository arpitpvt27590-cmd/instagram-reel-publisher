# Instagram Reel Publisher (Cloudflare starter)

This is a private dashboard starter for publishing Reels to Instagram professional accounts using Meta's official Instagram Graph API.

## What it does
- Responsive browser dashboard for phone or laptop
- Select one or more configured Instagram accounts
- Upload an MP4, enter a caption, optionally upload a cover image
- Calls a Cloudflare Worker to publish to selected accounts
- Uses Cloudflare R2 for temporary media files (the Worker removes them after the publishing attempt)

## Important limitations
- Instagram publishing requires eligible **professional** accounts and Meta app/API setup.
- This starter uses server-side account configuration, not an in-app Meta OAuth flow. You must obtain valid Meta access tokens and Instagram User IDs and add them as Cloudflare Worker secrets. Never put tokens in GitHub or browser code.
- R2 media must be reachable by Meta's servers during processing. Configure a public R2 custom domain for the bucket used by this app; do not store sensitive files in that public bucket. The app uses random temporary object names and deletes them after processing.
- Publishing can take time and Meta may return processing errors. Test with one account first.
- A public website with a password is not a substitute for protecting Worker secrets. Set a strong dashboard password and keep the repository private.
- Meta's current API requirements, permissions, rate limits and cover-image support can change; consult Meta's current documentation before production use.

## Files
- `public/index.html`: frontend dashboard
- `worker/index.js`: Cloudflare Worker API
- `wrangler.toml`: Worker/R2 configuration template

## Deploy overview
1. Create a Cloudflare Pages project and upload/deploy the `public` directory (or connect this GitHub repository).
2. Create an R2 bucket for temporary media. Enable a public custom domain for this bucket in Cloudflare R2 settings. Use a dedicated bucket only for temporary Reel media.
3. Deploy `worker/index.js` as a Cloudflare Worker, using `wrangler.toml` as a starting point. Bind the R2 bucket as `MEDIA`.
4. Add Worker secrets/variables:
   - `DASHBOARD_PASSWORD`: a long unique password
   - `META_ACCOUNTS_JSON`: JSON array, example below
   - `R2_PUBLIC_BASE_URL`: your R2 custom domain, e.g. `https://media.example.com`
   - `ALLOWED_ORIGIN`: your deployed Pages origin, e.g. `https://your-project.pages.dev`
5. Configure the Worker URL in `public/index.html` in `API_BASE`.
6. Add CORS and route settings as required, redeploy, and test with a short video.

### `META_ACCOUNTS_JSON` example
Set this as a Worker secret (not in this repository). Replace placeholders with real values:
```json
[
  {
    "id": "ig-account-1",
    "label": "Main Instagram",
    "igUserId": "YOUR_INSTAGRAM_USER_ID",
    "accessToken": "YOUR_META_ACCESS_TOKEN",
    "graphVersion": "vXX.X"
  }
]
```
Use the Graph API version currently supported by your Meta app, e.g. replace `vXX.X` with the version shown in Meta's documentation. Do not paste actual tokens into chat or GitHub.

## Meta publishing notes
The Worker uses the Instagram container workflow: create a media container with `media_type=REELS`, `video_url`, `caption`, poll container status, then publish the container. API behavior and available parameters depend on the API version and account permissions. This template deliberately reports API errors rather than claiming a Reel was published when it wasn't.

## Security checklist before real use
- Keep GitHub repository private.
- Use a long unique dashboard password.
- Never add secrets to GitHub.
- Use a dedicated temporary-media R2 bucket and enable cleanup/lifecycle rules.
- Restrict CORS to your exact Pages origin.
- Do not expose the Worker admin routes without password auth.
