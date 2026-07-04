This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## eBay Marketplace Account Deletion Notifications

This app exposes the eBay Marketplace Account Deletion callback at:

```text
https://ai-marketplace-teal.vercel.app/api/ebay/account-deletion
```

The route is implemented at `app/api/ebay/account-deletion/route.ts`. It supports:

- `GET ?challenge_code=...`: returns `{ "challengeResponse": "<sha256>" }`.
- `POST`: acknowledges eBay deletion notifications with `202` and schedules the deletion/anonymization hook.

Required Vercel environment variables:

```text
EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN=<32-80 chars: letters, numbers, underscore, or hyphen>
EBAY_MARKETPLACE_DELETION_ENDPOINT=https://ai-marketplace-teal.vercel.app/api/ebay/account-deletion
```

The endpoint env var must exactly match the HTTPS notification endpoint entered in the eBay Developer Portal.

Vercel deployment steps:

```bash
npx vercel env add EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN production
npx vercel env add EBAY_MARKETPLACE_DELETION_ENDPOINT production
npx vercel --prod
```

For Git-based deployments, you can also add the two variables in Vercel Project Settings > Environment Variables, then redeploy production.

Local challenge test in PowerShell:

```powershell
$env:EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN = "your-32-plus-character-token"
$env:EBAY_MARKETPLACE_DELETION_ENDPOINT = "http://localhost:3000/api/ebay/account-deletion"
npm run dev
```

Then, in a second terminal:

```powershell
curl.exe "http://localhost:3000/api/ebay/account-deletion?challenge_code=123"
```

Local challenge test in bash:

```bash
EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN="your-32-plus-character-token" \
EBAY_MARKETPLACE_DELETION_ENDPOINT="http://localhost:3000/api/ebay/account-deletion" \
npm run dev

curl "http://localhost:3000/api/ebay/account-deletion?challenge_code=123"
```

Production challenge test after deployment:

```bash
curl "https://ai-marketplace-teal.vercel.app/api/ebay/account-deletion?challenge_code=123"
```
