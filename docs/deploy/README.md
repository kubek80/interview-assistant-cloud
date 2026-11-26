# Deploying Interview Assistant on Google Cloud

> **Status: not yet tried on Google Cloud.** This guide and the `Dockerfile` were written where neither Docker nor Google Cloud was available. What *was* run there: the exact build (`npm ci`, `npm run build`), a copy with production dependencies only (`npm ci --omit=dev`) running `node dist/server/cli.js migrate`, `… seed` and `node dist/server/main.js` with production settings against PostgreSQL 16, and the full test suites. CI builds the image on every push. On your first deployment, follow the steps in order and do the **Check** at the end of each; please report anything that differs.

The app is one container image (browser app + API, `HOST-2`) on **Cloud Run**, a **Cloud SQL for PostgreSQL 16** database reached through the Cloud SQL connector (a Unix socket inside the container, no public database address), secrets in **Secret Manager**, sign-in with **Google**. Step 3 adds Cloud Storage for recordings and a Cloud Scheduler job for retention; their placeholders are at the end.

Every command uses these placeholders. Set them once in your shell:

```sh
export PROJECT_ID=your-project-id
export REGION=europe-west2                 # or australia-southeast1, us-central1, …
export INSTANCE=ia-db                      # Cloud SQL instance name
export DB_NAME=interview_assistant
export DB_USER=ia_app
export REPO=interview-assistant            # Artifact Registry repository
export SERVICE=interview-assistant         # Cloud Run service
export SA=ia-run                           # service account the app runs as
export DOMAIN=interviews.example.com       # the address people will use (see step 11)
export ADMINS=you@example.com              # first administrator(s), comma-separated (AUTH-3)
export TAG=$(git rev-parse --short HEAD)   # image tag: the commit being deployed
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/app:$TAG
gcloud config set project $PROJECT_ID
```

## 1. Enable the APIs

```sh
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com iam.googleapis.com cloudscheduler.googleapis.com
```

**Check:** `gcloud services list --enabled` lists all seven.

## 2. Artifact Registry (where the image is stored)

```sh
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION \
  --description="Interview Assistant images"
```

## 3. Cloud SQL for PostgreSQL

```sh
gcloud sql instances create $INSTANCE --database-version=POSTGRES_16 --region=$REGION \
  --edition=ENTERPRISE --tier=db-custom-1-3840 --storage-auto-increase \
  --backup-start-time=02:00 --enable-point-in-time-recovery --retained-backups-count=14 \
  --deletion-protection
# For production, consider --availability-type=REGIONAL (a standby in another zone).

gcloud sql databases create $DB_NAME --instance=$INSTANCE
DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
gcloud sql users create $DB_USER --instance=$INSTANCE --password="$DB_PASSWORD"
export CONN=$(gcloud sql instances describe $INSTANCE --format='value(connectionName)')   # PROJECT:REGION:INSTANCE
```

The app connects as `$DB_USER`, which owns nothing yet. Migrations create the tables as that user, so it becomes their owner; nothing in the app needs a superuser.

**Check:** `gcloud sql instances describe $INSTANCE --format='value(state,databaseVersion)'` prints `RUNNABLE POSTGRES_16`.

## 4. Secrets (HOST-3)

Secrets are never in the repository, in environment variables in plain text, or in logs.

```sh
printf %s "$DB_PASSWORD" | gcloud secrets create ia-db-password --data-file=-
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create ia-session-secret --data-file=-
# The Google sign-in client secret is added in step 6.
unset DB_PASSWORD
```

## 5. A service account with least privilege

```sh
gcloud iam service-accounts create $SA --display-name="Interview Assistant (Cloud Run)"
export SA_EMAIL=$SA@$PROJECT_ID.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA_EMAIL --role=roles/cloudsql.client
for s in ia-db-password ia-session-secret; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA_EMAIL --role=roles/secretmanager.secretAccessor
done
```

It may connect to Cloud SQL and read exactly these secrets; Cloud Run writes its logs. Nothing else. (Step 3 adds `roles/storage.objectUser` on the recordings bucket only.)

## 6. Google sign-in (AUTH-1)

Google does not offer a `gcloud` command for ordinary OAuth clients, so this step is in the console.

1. **APIs & Services → OAuth consent screen.** User type **Internal** if everyone signs in with your Google Workspace organisation's accounts (recommended: other Google accounts cannot even reach the consent screen); otherwise **External**, publishing status "In production". App name "Interview Assistant", your support email. Scopes: `openid`, `email`, `profile` only.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID.** Type **Web application**. Authorised redirect URI: `https://$DOMAIN/api/auth/google/callback` (add the `run.app` address from step 10 too while you have no domain yet). No JavaScript origins are needed: sign-in happens on the server.
3. Store the client secret and note the client id:

```sh
printf %s 'PASTE-CLIENT-SECRET' | gcloud secrets create ia-google-client-secret --data-file=-
gcloud secrets add-iam-policy-binding ia-google-client-secret --member=serviceAccount:$SA_EMAIL --role=roles/secretmanager.secretAccessor
export GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
```

## 7. Build and push the image

```sh
gcloud builds submit --tag $IMAGE .
# or, with Docker locally:  docker build -t $IMAGE . && docker push $IMAGE
```

The build runs the typecheck; the image runs as a non-root user on distroless Node.js 22 and holds the built app, the server, the migrations and the bundled question files.

**Check:** `gcloud artifacts docker images list $REGION-docker.pkg.dev/$PROJECT_ID/$REPO` shows the tag.

## 8. The settings every container gets

```sh
export DB_URL="postgres://$DB_USER@/$DB_NAME?host=/cloudsql/$CONN"
export COMMON_ENV="NODE_ENV=production,DATABASE_URL=$DB_URL"
export COMMON_SECRETS="DB_PASSWORD=ia-db-password:latest"
```

Every variable is described in `.env.example`.

## 9. The release job: migrations (before every release) and the seed (once)

Migrations run as a Cloud Run job with the same image, *before* the service gets the new version (`HOST-4`). They are safe to run repeatedly and from two places at once.

```sh
gcloud run jobs create ia-migrate --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --set-cloudsql-instances=$CONN --set-env-vars="$COMMON_ENV" --set-secrets="$COMMON_SECRETS" \
  --command=/nodejs/bin/node --args=dist/server/cli.js,migrate --max-retries=0 --task-timeout=10m
gcloud run jobs execute ia-migrate --region=$REGION --wait

# First installation only: import the four bundled tracks (DB-3). Running it again changes nothing.
gcloud run jobs create ia-seed --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --set-cloudsql-instances=$CONN --set-env-vars="$COMMON_ENV" --set-secrets="$COMMON_SECRETS" \
  --command=/nodejs/bin/node --args=dist/server/cli.js,seed --max-retries=0
gcloud run jobs execute ia-seed --region=$REGION --wait
```

**Check:** the job's logs (`gcloud run jobs executions list --job=ia-migrate --region=$REGION`, then the log link) say `Applied 2 migration(s)` the first time and `Nothing to apply` after; the seed says `Total: 207 added`.

Do not run the seed as part of every release: it would not undo app edits (newer versions are kept), but questions retired in the app since would be restored by an older file. Import later question files with the same job and `--args=dist/server/cli.js,import-questions,seed/qa.json,--dry-run` first, or upload them in the app (Admin › Question files).

## 10. The Cloud Run service

```sh
gcloud run deploy $SERVICE --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --add-cloudsql-instances=$CONN \
  --set-env-vars="$COMMON_ENV,PUBLIC_URL=https://$DOMAIN,BOOTSTRAP_ADMINS=$ADMINS,GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID" \
  --set-secrets="$COMMON_SECRETS,SESSION_SECRET=ia-session-secret:latest,GOOGLE_CLIENT_SECRET=ia-google-client-secret:latest" \
  --allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi \
  --min-instances=1 --max-instances=4 --concurrency=80 --timeout=3600 \
  --no-cpu-throttling --execution-environment=gen2
```

Why these values:

- `--allow-unauthenticated`: the app does its own sign-in (Google, invited people only); Cloud Run's IAM would put a second, unrelated sign-in in front of it.
- `--timeout=3600` (the maximum): live updates are Server-Sent Events, one long request per open browser tab. The server ends each stream after `LIVE_STREAM_MAX_MINUTES` (15) and the browser reconnects at once, well inside the limit.
- `--concurrency=80`: each open tab holds one request, so 80 per instance is about 30 people with two or three tabs each, plus their API calls. Raise `--max-instances` for more people.
- `--min-instances=1` and `--no-cpu-throttling`: an instance stays warm, and its database listener (PostgreSQL `LISTEN`, which delivers live updates between instances, `HOST-5`) keeps CPU between requests.
- Session affinity is not needed: nothing is kept in an instance's memory (`HOST-5`). Sessions, live updates and everything else go through the database.
- Database connections: `DATABASE_POOL_MAX` (default 10) per instance plus one listener. Keep `max-instances × 11` + 2 (release jobs) below the instance's `max_connections` (about 100 for `db-custom-1-3840`).

**Check:** `curl -s https://<the run.app URL>/healthz` prints `{"status":"ok","database":"ok"}`; `curl -sI https://<URL>/` shows `content-security-policy` and `strict-transport-security`.

## 11. Your domain and HTTPS

Cloud Run serves HTTPS on its `run.app` address. For your own domain either:

- **Cloud Run domain mapping** (simplest, available in some regions): `gcloud beta run domain-mappings create --service=$SERVICE --domain=$DOMAIN --region=$REGION`, then create the DNS records it prints; the certificate is managed by Google; or
- **a global external Application Load Balancer** with a serverless network endpoint group for the service and a Google-managed certificate (needed in regions without domain mapping, or to add Cloud Armor).

Then make sure `PUBLIC_URL=https://$DOMAIN` (step 10) and the OAuth redirect URI (step 6) use exactly that address. `TRUST_PROXY` is on in production, so the client address used for rate limiting comes from Google's front end.

## 12. First sign-in: the manual check of real Google sign-in

Automated tests use a stand-in for Google and the real OpenID library against a local provider; the real round trip can only be checked here. With two Google accounts, A on `BOOTSTRAP_ADMINS` and B not:

1. Open `https://$DOMAIN`, choose **Sign in with Google**, sign in as A. You arrive on the start page as an administrator; **Users** lists A.
2. In a private window, sign in as B: **You don't have access**. Nothing else about the app is shown.
3. As A, add B on the Users page as an interviewer. B signs in again: B sees the question bank, read-only, and no Users or Admin.
4. As A, deactivate B. B's open page returns to the sign-in screen within seconds; B's next sign-in is refused.
5. Sign out as A; the back button does not bring the app back.
6. Admin › Audit log shows each of these.

## 13. Releasing a new version

```sh
export TAG=$(git rev-parse --short HEAD); export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/app:$TAG
gcloud builds submit --tag $IMAGE .
gcloud run jobs update ia-migrate --image=$IMAGE --region=$REGION
gcloud run jobs execute ia-migrate --region=$REGION --wait
gcloud run deploy $SERVICE --image=$IMAGE --region=$REGION
```

Migrations must keep the previous version working (add tables and columns first; remove old ones in a later release), so the old revision keeps running while the new one starts, and a rollback stays possible.

## 14. Rolling back

```sh
gcloud run revisions list --service=$SERVICE --region=$REGION
gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=<previous-revision>=100
```

Migrations are not undone by this (they are forward-only and, per section 13, compatible with the previous version). If a migration itself damaged data, restore the database to just before it (point-in-time recovery, section 15) into a new instance, check it, and point `DATABASE_URL`'s socket at it.

## 15. Backups

Section 3 turned on daily backups (14 kept) and point-in-time recovery (7 days of logs by default). To restore to a moment:

```sh
gcloud sql instances clone $INSTANCE ${INSTANCE}-restore --point-in-time='2026-11-26T10:00:00Z'
```

A clone is a new instance: check it before switching to it. Try a restore once before going live. For a copy outside Cloud SQL: `gcloud sql export sql $INSTANCE gs://<bucket>/ia-$(date +%F).sql.gz --database=$DB_NAME` (the instance's service account needs write access to the bucket).

## 16. Logs

The server writes one JSON line per event to standard output; Cloud Logging reads `severity` and `message`. Each request has a `reqId` (also in the `x-request-id` response header and in error messages people can quote). Logs never carry candidate data, notes, scores, email addresses or tokens (`HOST-7`): requests are logged as method, path without the query string, status and time.

## 17. Live updates: limits

- Events are small hints (`{"topic":"bank","kind":"question","id":"qa-11"}`); browsers refetch the data through the normal, permission-checked API. PostgreSQL limits a notification to 8000 bytes; the server refuses anything near that.
- Nothing is replayed: a browser that was disconnected refetches everything it shows when it reconnects (`event: ready`). EventSource reconnects by itself after 3 seconds.
- Streams end after 15 minutes (or when the instance shuts down) and reconnect, so the Cloud Run request timeout is never reached. A person who is deactivated or signed out loses their stream at once or at the next 20-second heartbeat.

## 18. Placeholders for step 3

```sh
# Recordings (HPRIV-5): a private bucket, reachable only by the service account.
# gcloud storage buckets create gs://$PROJECT_ID-ia-recordings --location=$REGION --uniform-bucket-level-access --public-access-prevention
# gcloud storage buckets add-iam-policy-binding gs://$PROJECT_ID-ia-recordings --member=serviceAccount:$SA_EMAIL --role=roles/storage.objectUser

# Retention (HPRIV-2): a daily job that deletes what is past its retention date.
# gcloud run jobs create ia-retention --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
#   --set-cloudsql-instances=$CONN --set-env-vars="$COMMON_ENV" --set-secrets="$COMMON_SECRETS" \
#   --command=/nodejs/bin/node --args=dist/server/cli.js,retention
# gcloud scheduler jobs create http ia-retention-daily --location=$REGION --schedule="17 3 * * *" \
#   --uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/ia-retention:run" \
#   --http-method=POST --oauth-service-account-email=$SA_EMAIL
#   (the scheduler's service account then needs roles/run.invoker on the job)

# AI second opinion (HPRIV-6): the provider key in Secret Manager, readable by the service account only.
# printf %s 'KEY' | gcloud secrets create ia-ai-key --data-file=-
```
