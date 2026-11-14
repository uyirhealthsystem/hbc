# CI/CD to AWS ECS Fargate: Learn, Deploy, Observe

A hands-on course for deploying the **Home Based Care API** (this repo) to **AWS ECS on Fargate** with a **GitHub Actions** CI/CD pipeline, then practising **observability**: logs, metrics, alarms and breaking things on purpose.

Work through it in order. Each part explains the concept first, then shows how it applies to *this* project, then gives commands to run.

| Part | You will learn | Hands-on? |
|---|---|---|
| [0. Roadmap](#part-0--roadmap-and-prerequisites) | What you need, in what order | Setup |
| [1. Concepts](#part-1--concepts-the-mental-model) | CI vs CD, containers, ECS vocabulary, networking, IAM | Reading |
| [2. Architecture](#part-2--target-architecture-for-this-project) | How HBC will run on AWS, and what is specific to it | Reading |
| [3. Containerise](#part-3--containerise-the-app) | Dockerfile, .dockerignore, local run with Postgres | Local |
| [4. AWS foundation](#part-4--build-the-aws-foundation-by-hand) | ECR, RDS, Secrets, IAM, ALB, ECS service, by hand | AWS |
| [5. Pipeline](#part-5--the-cicd-pipeline-github-actions) | GitHub OIDC, CI job, CD job, migrations, deploy checks | GitHub + AWS |
| [6. Releases](#part-6--deployment-strategies-and-rollback) | Rolling, circuit breaker, rollback, blue/green | AWS |
| [7. Observability](#part-7--observability) | Logs, metrics, alarms, dashboards, tracing | AWS |
| [8. Practice labs](#part-8--observability-practice-labs) | 10 break-and-fix labs | AWS |
| [9. Cost and cleanup](#part-9--cost-and-cleanup) | What it costs, how to delete everything | AWS |
| [10. Troubleshooting](#part-10--troubleshooting) | Common errors and their fixes | Reference |

---

## Part 0 — Roadmap and prerequisites

### What you need

| Tool | Why | Check |
|---|---|---|
| AWS account (with billing alarm set) | Where the app runs | Console login works |
| AWS CLI v2 | Create resources from the terminal | `aws --version` |
| Docker Desktop | Build and run images locally | `docker version` |
| Git + GitHub account | Source code and the pipeline | `git --version` |
| Node 22 | Build locally | `node -v` |
| `jq` | Build JSON in shell scripts | `jq --version` |

> **Tip:** Run the AWS commands in **AWS CloudShell** (the `>_` icon in the AWS console). It already has the AWS CLI, `jq` and your credentials, and it uses Linux shell syntax, so you avoid Windows quoting problems. Build and push Docker images from your own machine.

### Set a billing alarm first

AWS Console → **Billing and Cost Management → Budgets → Create budget → Zero spend / Monthly cost budget** (e.g. $20). You will get an email before you overspend. Do this before anything else.

### Put the project in Git

This folder is not a Git repository yet. The pipeline runs from GitHub, so:

```bash
cd B:/uyir/hbc
git init -b main
git add .
git status            # confirm .env and node_modules are NOT listed (.gitignore covers them)
git commit -m "Initial commit"
# Create an empty private repo on GitHub named hbc, then:
git remote add origin https://github.com/<you>/hbc.git
git push -u origin main
```

> **Never commit `.env`.** It holds secrets. `.gitignore` already excludes it. In AWS, secrets go into **Secrets Manager** (Part 4).

### Learning order

1. Read Parts 1 and 2 fully. Don't run anything yet.
2. Part 3: get the container running on your laptop.
3. Part 4: build the AWS pieces **by hand** so you understand each one.
4. Part 5: automate it with the pipeline.
5. Parts 6–8: practise releases and observability.
6. Part 9: delete everything when you are done.

---

## Part 1 — Concepts (the mental model)

### 1.1 CI, CD and the pipeline

| Term | Meaning | For this project |
|---|---|---|
| **CI** (Continuous Integration) | Every change is automatically built and checked | `npm ci`, `typecheck`, `build`, migrations against a throwaway Postgres, Docker build, container smoke test |
| **Continuous Delivery** | Every passing change *can* be released with one click | A manual approval before production |
| **Continuous Deployment** | Every passing change on `main` *is* released automatically | Push to `main` → live in ~5 minutes |
| **Pipeline** | The ordered stages that take a commit to production | GitHub Actions workflow |
| **Artifact** | The thing you build once and deploy | A Docker **image**, tagged with the Git commit SHA |

```
 developer          GitHub                         AWS
 ─────────          ──────                         ───
 git push ──► [CI job]                             
               install → typecheck → build         
               → migrate test DB → docker build    
               → smoke test container              
                   │ pass, and branch is main      
                   ▼                               
             [CD job] ──OIDC──► assume deploy role 
               docker push ───────────────────► ECR (image registry)
               register task definition ──────► ECS
               run migration task ────────────► ECS (one-off task) ──► RDS
               update service ────────────────► ECS service (rolling deploy)
               wait + verify ◄──────────────── healthy behind ALB
```

Principles to remember:

- **Build once, deploy the same artifact everywhere.** The image tagged `abc1234` is exactly what runs.
- **Immutable tags.** Never reuse a tag like `latest` for deployments. Use the commit SHA so you always know what is running, and can roll back to it.
- **Config in the environment, not in the image** ([12-factor](https://12factor.net/config)). This app already does that: `src/config/env.ts` reads everything from environment variables.
- **The pipeline is the only way to production.** No manual `docker push` to prod once the pipeline exists.

### 1.2 Containers

| Term | Meaning |
|---|---|
| **Image** | A read-only package: OS libraries + Node + your `dist/` + `node_modules`. Built from a `Dockerfile` |
| **Container** | A running instance of an image |
| **Registry** | Stores images. On AWS this is **ECR** (Elastic Container Registry) |
| **Multi-stage build** | Build with dev tools (TypeScript) in one stage, copy only the output into a small runtime stage |
| **Platform** | CPU architecture: `linux/amd64` (x86) or `linux/arm64` (Graviton). The image and the Fargate task must match |

### 1.3 ECS vocabulary

ECS (Elastic Container Service) is AWS's container orchestrator. **Fargate** is the "serverless" way to run it: you never manage EC2 machines, you just say "run this container with 0.25 vCPU and 512 MB".

| ECS term | What it is | Analogy |
|---|---|---|
| **Cluster** | A logical group of services and tasks | A namespace / project |
| **Task definition** | A versioned JSON blueprint: image, CPU/memory, ports, env vars, secrets, logging, health check, IAM roles. Each change creates a new **revision** (`hbc-api:1`, `hbc-api:2`, …) | `docker-compose.yml` for one service |
| **Task** | One running copy of a task definition (one or more containers) | A running container |
| **Service** | Keeps *N* tasks running, replaces failed ones, registers them with the load balancer, and performs rolling deployments | A supervisor |
| **Fargate** | The launch type: the compute | Serverless containers |
| **Standalone task** | A task run once, not by a service (e.g. database migrations) | `docker run --rm` |
| **ECS Exec** | Open a shell inside a running Fargate container | `docker exec` |

### 1.4 Networking

| Term | Meaning |
|---|---|
| **VPC** | Your private network in AWS |
| **Subnet** | A slice of the VPC in one AvailabiAWS provides lity Zone (AZ). **Public** subnets route to the internet gateway, **private** subnets don't |
| **Security group (SG)** | A stateful firewall attached to a resource. Rules can say "allow port 4000 *from the ALB's security group*" rather than from IP addresses |
| **ALB** (Application Load Balancer) | Receives HTTP(S) from the internet and spreads it over healthy tasks |
| **Target group** | The list of task IPs the ALB sends traffic to, with a **health check** (`GET /health`) |
| **NAT gateway** | Lets tasks in *private* subnets reach the internet (to pull images). Costs about $32/month + data, so this guide avoids it |

**This guide's choice (cheap, fine for learning):** use the **default VPC**, run tasks in **public subnets with a public IP** so they can pull from ECR without a NAT gateway, and use **security groups** so that *only the ALB* can reach the tasks and *only the tasks* can reach the database.

**Production choice:** tasks in private subnets, with a NAT gateway or VPC endpoints (ECR, S3, Logs, Secrets Manager).

### 1.5 IAM: the two roles every task has

This is the most confusing part for beginners. Learn it now.

| Role | Used by | Needs permission to | In this project |
|---|---|---|---|
| **Task execution role** | The **ECS agent**, *before* your container starts | Pull the image from ECR, write logs to CloudWatch, read secrets from Secrets Manager | `hbc-ecs-execution-role` |
| **Task role** | **Your application code**, while it runs | Whatever AWS APIs your code calls (S3, SQS, …) | `hbc-ecs-task-role`. HBC calls no AWS APIs, so it only gets the permissions **ECS Exec** needs |
| **Deploy role** | **GitHub Actions** | Push to ECR, register task definitions, update the service, run the migration task | `hbc-github-deploy-role` |

**GitHub OIDC:** instead of storing long-lived AWS access keys in GitHub, GitHub gets a short-lived token that AWS trusts for *this one repository*. No secrets to leak or rotate.

### 1.6 Secrets and configuration

| Kind | Example | Where it goes |
|---|---|---|
| Plain config | `NODE_ENV`, `PORT`, `SERVICE_RADIUS_KM`, `PAYMENT_SERVICE_URL` | Task definition `environment` |
| Secrets | `DATABASE_URL` (contains password), `PAYMENT_WEBHOOK_SECRET`, `GATEWAY_SHARED_SECRET` | **Secrets Manager**, referenced in the task definition `secrets` block. ECS injects them as env vars at start |

### 1.7 Observability (preview)

| Pillar | Question it answers | AWS service |
|---|---|---|
| **Logs** | *What exactly happened?* | CloudWatch Logs + Logs Insights |
| **Metrics** | *How much / how fast / how often?* | CloudWatch Metrics, Container Insights, ALB metrics |
| **Traces** | *Where did the time go across services?* | AWS X-Ray / OpenTelemetry (ADOT) |
| **Alarms** | *Wake me up when it matters* | CloudWatch Alarms → SNS email |

---

## Part 2 — Target architecture for this project

```
                       Internet
                          │ HTTP :80  (HTTPS :443 once you add a domain + ACM cert)
                          ▼
              ┌───────────────────────┐   SG: hbc-alb-sg (80 from anywhere)
              │ Application Load       │
              │ Balancer  hbc-alb      │── health check GET /health
              └──────────┬────────────┘
                         │ :4000 (only from the ALB SG)
          ┌──────────────┴──────────────┐   SG: hbc-app-sg
          ▼                             ▼
   ┌──────────────┐              ┌──────────────┐
   │ Fargate task │   ECS        │ Fargate task │   (desired count 1–2, autoscaling later)
   │ hbc-api      │   service    │ hbc-api      │
   │ node dist/   │   hbc-api    │              │
   │  server.js   │              │              │
   └──────┬───────┘              └──────┬───────┘
          │ :5432 (only from the app SG) │          logs ──► CloudWatch Logs /ecs/hbc-api
          └──────────────┬───────────────┘          secrets ◄── Secrets Manager hbc/prod
                         ▼                          image ◄── ECR hbc-api:<git sha>
              ┌───────────────────────┐   SG: hbc-db-sg
              │ RDS PostgreSQL         │
              │ hbc-db (db.t4g.micro)  │
              └───────────────────────┘
```

### Facts about this codebase that shape the deployment

Read each one. They come from the actual code.

1. **Health endpoint.** `GET /health` returns `{"status":"ok"}` (`src/app.ts`). The ALB and the container health check use it. It does **not** touch the database, so it measures "the process is alive", not "the app can serve requests" (you'll explore this in Lab 6).
2. **Port.** The app listens on `PORT`, default `4000`.
3. **Graceful shutdown.** `src/server.ts` handles `SIGTERM`: it stops accepting connections, then closes the DB pool. ECS sends `SIGTERM` when it stops a task, so in-flight requests finish. The container must run `node` directly (exec form `CMD`), not through `npm start`, so that Node actually receives the signal.
4. **Config validation fails fast.** `src/config/env.ts` validates env vars with zod and calls `process.exit(1)` if they are wrong. With `NODE_ENV=production` it **requires** `PAYMENT_SERVICE_URL` and `PAYMENT_WEBHOOK_SECRET`, and **refuses** `PAYMENT_SEND_IDENTITY_HEADERS=true`. A bad config means the task dies at once and the deployment circuit breaker rolls back (Lab 2).
5. **Migrations are not run at startup.** They are plain SQL files in `src/db/migrations`, applied by `src/db/migrate.ts` and tracked in `schema_migrations`. `npm run build` copies them into `dist/db/migrations`, so the image can run them with `node dist/db/migrate.js`. The pipeline runs this as a **one-off ECS task before** updating the service.
6. **Identity is trusted from headers.** `src/middleware/auth.ts` trusts `X-User-Id` and `X-Role` from the API gateway and does not verify JWTs. **If the ALB is public, anyone can forge these headers.** So in AWS you must:
   - set `GATEWAY_SHARED_SECRET` (16+ chars), so that every authenticated request must carry a matching `X-Gateway-Secret`, **and**
   - in real production, make the ALB **internal** and reachable only by the Uyir API gateway (or run the gateway on ECS and use ECS Service Connect).
7. **Payments.** HBC calls the Uyir **payment-service** (`PAYMENT_SERVICE_URL`), and payment-service calls back to `POST /api/v1/hbc/payments/webhook`. That route is authenticated by an HMAC signature, not gateway headers, so payment-service must reach HBC **directly** (the ALB URL, or via Service Connect), not through the gateway. If payment-service is not deployed yet, set `PAYMENT_SERVICE_URL` to a placeholder like `https://payments.invalid`: the app starts, and only `/pay` fails.
8. **Database TLS.** RDS PostgreSQL forces TLS. `node-postgres` will reject the RDS certificate unless it trusts the RDS CA, so the image includes the RDS CA bundle and `DATABASE_URL` uses `sslmode=verify-full&sslrootcert=...`.
9. **Logs.** The app logs with `console.log` / `console.error` to stdout/stderr. The `awslogs` driver ships that to CloudWatch. Lines starting `[payments]` are important business signals (e.g. `REFUND REQUIRED`, `DOUBLE PAYMENT`, `payment-service unreachable`) that you'll turn into metrics and alarms.

---

## Part 3 — Containerise the app

Create these files in the project root.

### 3.1 `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1

# ---------- build stage: has TypeScript and all devDependencies ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy only the manifests first, so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Compiles to dist/ and copies src/db/migrations -> dist/db/migrations (see package.json "build").
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage: only what is needed to run ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Amazon RDS certificate bundle, so node-postgres can verify the database's TLS certificate.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Don't run as root.
USER node
EXPOSE 4000

# Exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown in src/server.ts).
CMD ["node", "dist/server.js"]
```

Why each choice:

| Line | Reason |
|---|---|
| `bookworm-slim` not `alpine` | This project uses TypeScript 7, which ships native binaries. Debian (glibc) avoids musl compatibility surprises |
| Two stages | The runtime image has no TypeScript, no `src/`, no devDependencies: smaller and less attack surface |
| Manifests copied first | Docker layer caching: changing `src/` doesn't re-run `npm ci` |
| `npm prune --omit=dev` | Removes `tsx`, `typescript` and `@types/*` from `node_modules` |
| `USER node` | The official image includes an unprivileged `node` user |
| `CMD ["node", ...]` | Not `npm start`: npm doesn't forward `SIGTERM` reliably |

### 3.2 `.dockerignore`

Keeps secrets and junk out of the build context.

```gitignore
node_modules
dist
.env
.env.*
.git
postman
scripts
docs
*.md
openapi.yaml
```

### 3.3 Build and run locally with Docker Compose

Create `docker-compose.yml`. It mimics the AWS flow: database → migration task → API.

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: home_care
    ports: ["5433:5432"]          # 5433 on your machine, so it doesn't clash with a local Postgres
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 3s
      retries: 20

  migrate:                         # like the one-off ECS migration task
    build: .
    command: ["node", "dist/db/migrate.js"]
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/home_care
    depends_on:
      db: { condition: service_healthy }

  api:                             # like the ECS service
    build: .
    ports: ["4000:4000"]
    environment:
      NODE_ENV: production
      PORT: "4000"
      DATABASE_URL: postgres://postgres:postgres@db:5432/home_care
      PAYMENT_SERVICE_URL: http://host.docker.internal:8083
      PAYMENT_WEBHOOK_SECRET: local-homecare-payment-secret
      GATEWAY_SHARED_SECRET: local-gateway-secret-1234
    depends_on:
      migrate: { condition: service_completed_successfully }
```

Run it:

```bash
docker compose up --build
# In another terminal:
curl http://localhost:4000/health                                    # {"status":"ok"}
curl http://localhost:4000/api/v1/hbc/catalog/services               # public route, hits the DB
docker compose down -v                                               # stop and delete the DB volume
```

**Exercises:**

1. Remove `PAYMENT_WEBHOOK_SECRET` from `api` and run again. Read the error. This is exactly what you'll see in CloudWatch in Lab 2.
2. Run `docker images` and note the image size. Try building a single-stage image (just `npm ci && npm run build`) and compare.
3. Run `docker compose stop api` and watch the logs. Graceful shutdown should exit quickly with code 0.

---

## Part 4 — Build the AWS foundation by hand

You'll create everything with the CLI once, so you understand every piece. (Later, the natural next step is to express this as Infrastructure as Code: Terraform, AWS CDK or CloudFormation.)

Run these in **AWS CloudShell** (or Git Bash with the AWS CLI configured). Keep the same shell open, because later steps reuse the variables.

### 4.0 Variables

```bash
export AWS_REGION=ap-south-1            # Mumbai. Pick the region closest to your users.
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export APP=hbc
export REPO_NAME=hbc-api
echo "Account $ACCOUNT_ID in $AWS_REGION"
```

> If CloudShell restarts, you lose these variables. Save the IDs you create (VPC, SGs, ARNs) into a notes file as you go.

### 4.1 ECR: the image registry

```bash
aws ecr create-repository \
  --repository-name $REPO_NAME \
  --image-tag-mutability IMMUTABLE \
  --image-scanning-configuration scanOnPush=true

# Keep only the newest 30 images, so storage doesn't grow forever.
aws ecr put-lifecycle-policy --repository-name $REPO_NAME --lifecycle-policy-text '{
  "rules": [{
    "rulePriority": 1,
    "description": "keep last 30 images",
    "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 30 },
    "action": { "type": "expire" }
  }]
}'
```

- `IMMUTABLE`: a tag can never be overwritten, so `hbc-api:abc1234` always means the same bytes.
- `scanOnPush`: ECR scans each image for known CVEs. Look at the findings in the console after your first push.

**Push the first image manually from your laptop** (this teaches you what the pipeline will do):

```bash
# On your machine (Git Bash), in the project folder
export AWS_REGION=ap-south-1
export ACCOUNT_ID=<your account id>
export REGISTRY=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REGISTRY
docker build --platform linux/amd64 -t $REGISTRY/hbc-api:manual-1 .
docker push $REGISTRY/hbc-api:manual-1
```

`--platform linux/amd64` matters on Apple Silicon Macs. On Windows/Intel it is already amd64. The task definition will say `X86_64` to match.

### 4.2 Network: default VPC and three security groups

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
export SUBNETS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text)
export SUBNETS_CSV=$(echo $SUBNETS | tr ' ' ',')
echo "VPC $VPC_ID  subnets $SUBNETS_CSV"

# 1) ALB: HTTP from anywhere
export ALB_SG=$(aws ec2 create-security-group --group-name hbc-alb-sg \
  --description "HBC ALB" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG --protocol tcp --port 80 --cidr 0.0.0.0/0

# 2) App tasks: port 4000 ONLY from the ALB security group
export APP_SG=$(aws ec2 create-security-group --group-name hbc-app-sg \
  --description "HBC ECS tasks" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $APP_SG --protocol tcp --port 4000 --source-group $ALB_SG

# 3) Database: port 5432 ONLY from the app security group
export DB_SG=$(aws ec2 create-security-group --group-name hbc-db-sg \
  --description "HBC RDS" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $DB_SG --protocol tcp --port 5432 --source-group $APP_SG
```

This is **security-group chaining**: nothing references IP addresses, so it keeps working as tasks come and go.

> If your account has no default VPC: `aws ec2 create-default-vpc`.

### 4.3 RDS PostgreSQL

```bash
# Alphanumeric only, so it's safe inside a URL without encoding.
export DB_PASSWORD=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24)

aws rds create-db-instance \
  --db-instance-identifier hbc-db \
  --engine postgres \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 \
  --storage-type gp3 \
  --master-username hbc_admin \
  --master-user-password "$DB_PASSWORD" \
  --db-name home_care \
  --vpc-security-group-ids $DB_SG \
  --no-publicly-accessible \
  --backup-retention-period 1 \
  --no-multi-az

echo "Waiting for RDS (5-10 minutes)..."
aws rds wait db-instance-available --db-instance-identifier hbc-db
export DB_HOST=$(aws rds describe-db-instances --db-instance-identifier hbc-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)
echo $DB_HOST
```

- `--no-publicly-accessible`: the DB has no internet address. Only things inside the VPC with the right SG can connect.
- Production upgrades: `--multi-az`, longer backups, `--deletion-protection`, a separate least-privilege app user instead of the master user, and `--manage-master-user-password` to let RDS rotate the password.

### 4.4 Secrets Manager

```bash
export WEBHOOK_SECRET=$(openssl rand -hex 32)      # must equal payment-service HOMECARE_PAYMENT_WEBHOOK_SECRET
export GATEWAY_SECRET=$(openssl rand -hex 24)      # the API gateway sends this as X-Gateway-Secret

export DATABASE_URL="postgres://hbc_admin:${DB_PASSWORD}@${DB_HOST}:5432/home_care?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem"

export SECRET_ARN=$(aws secretsmanager create-secret --name hbc/prod \
  --secret-string "$(jq -n \
     --arg db "$DATABASE_URL" --arg wh "$WEBHOOK_SECRET" --arg gw "$GATEWAY_SECRET" \
     '{DATABASE_URL:$db, PAYMENT_WEBHOOK_SECRET:$wh, GATEWAY_SHARED_SECRET:$gw}')" \
  --query ARN --output text)
echo $SECRET_ARN
```

One secret holds three JSON keys. The task definition picks each key with the syntax `<secret-arn>:<json-key>::`.

> Write down `GATEWAY_SECRET`. You need it to call authenticated routes (Postman `gatewaySecret` variable).

### 4.5 CloudWatch log group

```bash
aws logs create-log-group --log-group-name /ecs/hbc-api
aws logs put-retention-policy --log-group-name /ecs/hbc-api --retention-in-days 14
```

Without a retention policy, logs are kept (and billed) forever.

### 4.6 IAM roles for the task

```bash
cat > ecs-tasks-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

# --- Execution role: used by ECS to pull the image, write logs and read the secret ---
aws iam create-role --role-name hbc-ecs-execution-role \
  --assume-role-policy-document file://ecs-tasks-trust.json
aws iam attach-role-policy --role-name hbc-ecs-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name hbc-ecs-execution-role --policy-name read-hbc-secret \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"secretsmanager:GetSecretValue\",
      \"Resource\": \"$SECRET_ARN\"
    }]
  }"

# --- Task role: used by the app itself. HBC needs no AWS APIs; this only enables ECS Exec ---
aws iam create-role --role-name hbc-ecs-task-role \
  --assume-role-policy-document file://ecs-tasks-trust.json
aws iam put-role-policy --role-name hbc-ecs-task-role --policy-name ecs-exec \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"
      ],
      "Resource": "*"
    }]
  }'
```

### 4.7 ECS cluster

```bash
aws ecs create-cluster --cluster-name hbc \
  --settings name=containerInsights,value=enhanced
```

`containerInsights` publishes CPU, memory, network and task-count metrics per service and task. You'll use them in Part 7. (`enhanced` gives task- and container-level detail; `enabled` is the cheaper basic level.)

### 4.8 The task definition (commit this file)

Create `.aws/task-definition.json` in the repo. Replace `ACCOUNT_ID`, the region and the **full secret ARN** (from `echo $SECRET_ARN`; it ends with a random 6-character suffix).

```json
{
  "family": "hbc-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/hbc-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/hbc-ecs-task-role",
  "containerDefinitions": [
    {
      "name": "hbc-api",
      "image": "replaced-by-the-pipeline",
      "essential": true,
      "portMappings": [{ "containerPort": 4000, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "4000" },
        { "name": "SERVICE_RADIUS_KM", "value": "10" },
        { "name": "OTP_MAX_ATTEMPTS", "value": "5" },
        { "name": "PAYMENT_SERVICE_URL", "value": "https://payments.invalid" },
        { "name": "PAYMENT_REFERENCE_TYPE", "value": "HOME_CARE_BOOKING" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",           "valueFrom": "arn:aws:secretsmanager:ap-south-1:ACCOUNT_ID:secret:hbc/prod-AbCdEf:DATABASE_URL::" },
        { "name": "PAYMENT_WEBHOOK_SECRET", "valueFrom": "arn:aws:secretsmanager:ap-south-1:ACCOUNT_ID:secret:hbc/prod-AbCdEf:PAYMENT_WEBHOOK_SECRET::" },
        { "name": "GATEWAY_SHARED_SECRET",  "valueFrom": "arn:aws:secretsmanager:ap-south-1:ACCOUNT_ID:secret:hbc/prod-AbCdEf:GATEWAY_SHARED_SECRET::" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/hbc-api",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "api"
        }
      },
      "healthCheck": {
        "command": ["CMD", "node", "-e", "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 15
      },
      "stopTimeout": 30
    }
  ]
}
```

| Field | Why |
|---|---|
| `cpu: 256`, `memory: 512` | 0.25 vCPU / 0.5 GB, the smallest Fargate size. Enough for this API to start with |
| `networkMode: awsvpc` | Required by Fargate. Each task gets its own network interface and security group |
| `environment` | Non-secret config, visible in the console |
| `secrets` | Pulled from Secrets Manager by the **execution role** at start, injected as env vars, never shown in the console |
| `healthCheck` | Uses `node` itself because the slim image has no `curl`. Node 22 has `fetch` built in |
| `stopTimeout: 30` | Time between `SIGTERM` and `SIGKILL`, so graceful shutdown can finish |
| `PAYMENT_SERVICE_URL` | Placeholder until payment-service is deployed. Replace with its real URL |

Register revision 1 with the image you pushed by hand:

```bash
sed "s|replaced-by-the-pipeline|$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/hbc-api:manual-1|" \
  .aws/task-definition.json > /tmp/td.json
aws ecs register-task-definition --cli-input-json file:///tmp/td.json \
  --query 'taskDefinition.taskDefinitionArn' --output text
```

(In CloudShell, upload the file first with **Actions → Upload file**, or paste it with a heredoc.)

### 4.9 Run the migrations as a one-off task

```bash
TASK_ARN=$(aws ecs run-task --cluster hbc --launch-type FARGATE \
  --task-definition hbc-api \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS_CSV],securityGroups=[$APP_SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"hbc-api","command":["node","dist/db/migrate.js"]}]}' \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster hbc --tasks $TASK_ARN
aws ecs describe-tasks --cluster hbc --tasks $TASK_ARN \
  --query 'tasks[0].{exit:containers[0].exitCode, reason:stoppedReason}'
```

Exit code `0` = success. Now look in **CloudWatch → Log groups → /ecs/hbc-api**: you should see `applied 001_init.sql` … `migrations up to date`.

Same image, different **command**: that is the pattern for any one-off job (migrations, seed scripts, backfills).

### 4.10 Application Load Balancer

```bash
export ALB_ARN=$(aws elbv2 create-load-balancer --name hbc-alb --type application \
  --scheme internet-facing --subnets $SUBNETS --security-groups $ALB_SG \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

export TG_ARN=$(aws elbv2 create-target-group --name hbc-api-tg \
  --protocol HTTP --port 4000 --vpc-id $VPC_ID --target-type ip \
  --health-check-path /health --health-check-interval-seconds 15 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# Default is 300 s. 30 s is plenty for this API and makes deploys faster.
aws elbv2 modify-target-group-attributes --target-group-arn $TG_ARN \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30

aws elbv2 create-listener --load-balancer-arn $ALB_ARN --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN

export ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)
echo "http://$ALB_DNS"
```

- `--target-type ip`: required for Fargate (`awsvpc`). Targets are task IPs, not EC2 instances.
- **Deregistration delay**: when a task is stopping, the ALB stops sending it *new* requests and waits this long for in-flight ones to finish.
- **HTTPS (do it once you have a domain):** request a certificate in ACM, add a `443` listener with it, and change the `80` listener to redirect to `443`.

### 4.11 The ECS service

```bash
aws ecs create-service --cluster hbc --service-name hbc-api \
  --task-definition hbc-api --desired-count 1 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS_CSV],securityGroups=[$APP_SG],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=hbc-api,containerPort=4000" \
  --health-check-grace-period-seconds 30 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
  --enable-execute-command

aws ecs wait services-stable --cluster hbc --services hbc-api
curl http://$ALB_DNS/health
curl http://$ALB_DNS/api/v1/hbc/catalog/services
```

| Option | Meaning |
|---|---|
| `desired-count 1` | Keep one task running. Use 2 for availability across AZs |
| `health-check-grace-period-seconds` | Ignore ALB health failures for the first 30 s after a task starts |
| `minimumHealthyPercent=100, maximumPercent=200` | During a deploy, start the new task(s) **before** stopping the old ones: zero downtime |
| `deploymentCircuitBreaker` | If new tasks keep failing, stop the deploy and **roll back automatically** to the last good revision |
| `enable-execute-command` | Allows ECS Exec (`aws ecs execute-command`) for debugging |

**Test an authenticated route** (as the gateway would):

```bash
curl http://$ALB_DNS/api/v1/hbc/patient/bookings \
  -H "X-User-Id: 11111111-1111-1111-1111-111111111111" \
  -H "X-Role: PATIENT" \
  -H "X-Gateway-Secret: $GATEWAY_SECRET"
```

Try it again without `X-Gateway-Secret`: you get `401 Request did not come through the gateway`. That check is what protects this public ALB.

**Checkpoint:** you have deployed by hand. Every step the pipeline automates, you've now done yourself.

---

## Part 5 — The CI/CD pipeline (GitHub Actions)

### 5.1 Let GitHub assume an AWS role (OIDC, no access keys)

```bash
export GH_REPO=<your-github-user>/hbc     # owner/repo

# 1) Trust GitHub's OIDC issuer (once per AWS account).
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
# (Older AWS CLI versions also demand --thumbprint-list; AWS no longer uses it for GitHub.)

# 2) The deploy role, trusted ONLY by this repo's "production" environment.
cat > gh-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:$GH_REPO:environment:production"
      }
    }
  }]
}
EOF
aws iam create-role --role-name hbc-github-deploy-role --assume-role-policy-document file://gh-trust.json

# 3) Least-privilege permissions for deploying.
cat > gh-deploy-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                 "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage"],
      "Resource": "arn:aws:ecr:$AWS_REGION:$ACCOUNT_ID:repository/hbc-api" },
    { "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks",
                 "elasticloadbalancing:DescribeLoadBalancers"],
      "Resource": "*" },
    { "Effect": "Allow", "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:$AWS_REGION:$ACCOUNT_ID:service/hbc/hbc-api" },
    { "Effect": "Allow", "Action": "ecs:RunTask",
      "Resource": "arn:aws:ecs:$AWS_REGION:$ACCOUNT_ID:task-definition/hbc-api:*" },
    { "Effect": "Allow", "Action": "iam:PassRole",
      "Resource": ["arn:aws:iam::$ACCOUNT_ID:role/hbc-ecs-execution-role",
                   "arn:aws:iam::$ACCOUNT_ID:role/hbc-ecs-task-role"],
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } }
  ]
}
EOF
aws iam put-role-policy --role-name hbc-github-deploy-role --policy-name deploy \
  --policy-document file://gh-deploy-policy.json

echo "arn:aws:iam::$ACCOUNT_ID:role/hbc-github-deploy-role"
```

> **Gotcha:** the `sub` claim depends on how the job runs. A job with `environment: production` sends `repo:OWNER/REPO:environment:production`. A job without an environment sends `repo:OWNER/REPO:ref:refs/heads/main`. If they don't match the trust policy you get `Not authorized to perform sts:AssumeRoleWithWebIdentity`.

**`iam:PassRole`** is needed because registering a task definition and running a task "hands" the execution and task roles to ECS. The condition limits it to ECS.

### 5.2 Configure the GitHub repo

GitHub → repo → **Settings**:

1. **Environments → New environment → `production`**.
   - Optional: **Required reviewers** → yourself. Now every deploy waits for your click: *continuous delivery* instead of *deployment*.
   - **Deployment branches**: only `main`.
2. In the `production` environment, add **variables** (not secrets; none of these are sensitive):

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<account>:role/hbc-github-deploy-role` |
| `ECS_SUBNETS` | The value of `$SUBNETS_CSV`, e.g. `subnet-aaa,subnet-bbb,subnet-ccc` |
| `ECS_SECURITY_GROUP` | The value of `$APP_SG` |

3. **Branches → Add rule for `main`**: require pull requests, and require the `ci` status check to pass. Now broken code can't reach `main`.

### 5.3 The workflow: `.github/workflows/ci-cd.yml`

```yaml
name: ci-cd

on:
  pull_request:            # CI only
  push:
    branches: [main]       # CI, then CD
  workflow_dispatch:       # manual "Run workflow" button

permissions:
  contents: read

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: hbc-api
  ECS_CLUSTER: hbc
  ECS_SERVICE: hbc-api
  CONTAINER_NAME: hbc-api

jobs:
  # ---------------------------------------------------------------- CI
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:                       # throwaway database for this job only
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: home_care
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/home_care
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      - run: npm run typecheck
      - run: npm run build

      - name: Migrations apply cleanly to an empty database
        run: node dist/db/migrate.js

      - name: Build Docker image
        run: docker build -t hbc-api:ci .

      - name: Smoke test the container
        run: |
          docker run -d --name hbc --network host \
            -e NODE_ENV=production -e PORT=4000 \
            -e DATABASE_URL="$DATABASE_URL" \
            -e PAYMENT_SERVICE_URL=https://payments.invalid \
            -e PAYMENT_WEBHOOK_SECRET=ci-webhook-secret-0123456789 \
            -e GATEWAY_SHARED_SECRET=ci-gateway-secret-0123456789 \
            hbc-api:ci
          for i in $(seq 1 20); do
            if curl -fsS http://localhost:4000/health; then
              curl -fsS http://localhost:4000/api/v1/hbc/catalog/services && exit 0
            fi
            sleep 1
          done
          docker logs hbc
          exit 1

  # ---------------------------------------------------------------- CD
  deploy:
    needs: ci
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production           # approval gate + environment variables + OIDC "sub"
    concurrency:
      group: deploy-production        # never two deploys at once
      cancel-in-progress: false
    permissions:
      id-token: write                 # allows requesting the OIDC token
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Assume the AWS deploy role (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Log in to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image tagged with the commit SHA
        id: image
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          IMAGE="$REGISTRY/$ECR_REPOSITORY:$GITHUB_SHA"
          docker build -t "$IMAGE" .
          docker push "$IMAGE"
          echo "uri=$IMAGE" >> "$GITHUB_OUTPUT"

      - name: Put the new image into the task definition
        id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: .aws/task-definition.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ steps.image.outputs.uri }}

      - name: Register the new task definition revision
        id: register
        run: |
          ARN=$(aws ecs register-task-definition \
            --cli-input-json "file://${{ steps.render.outputs.task-definition }}" \
            --query taskDefinition.taskDefinitionArn --output text)
          echo "Registered $ARN"
          echo "arn=$ARN" >> "$GITHUB_OUTPUT"

      - name: Run database migrations (one-off task, new image)
        env:
          TASK_DEF: ${{ steps.register.outputs.arn }}
          SUBNETS: ${{ vars.ECS_SUBNETS }}
          SG: ${{ vars.ECS_SECURITY_GROUP }}
        run: |
          TASK=$(aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE \
            --task-definition "$TASK_DEF" \
            --started-by "migrate-${GITHUB_SHA:0:7}" \
            --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
            --overrides "{\"containerOverrides\":[{\"name\":\"$CONTAINER_NAME\",\"command\":[\"node\",\"dist/db/migrate.js\"]}]}" \
            --query 'tasks[0].taskArn' --output text)
          echo "Migration task: $TASK"
          aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$TASK"
          CODE=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK" \
            --query 'tasks[0].containers[0].exitCode' --output text)
          echo "Migration exit code: $CODE"
          if [ "$CODE" != "0" ]; then
            aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK" --query 'tasks[0].stoppedReason'
            echo "::error::Migrations failed. Check CloudWatch log group /ecs/hbc-api"
            exit 1
          fi

      - name: Deploy the new revision to the service
        env:
          TASK_DEF: ${{ steps.register.outputs.arn }}
        run: |
          aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
            --task-definition "$TASK_DEF" > /dev/null
          echo "Waiting for the service to become stable..."
          aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"

          # services-stable also succeeds after a circuit-breaker ROLLBACK, so check what is actually running.
          RUNNING=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
            --query 'services[0].deployments[?status==`PRIMARY`] | [0].taskDefinition' --output text)
          if [ "$RUNNING" != "$TASK_DEF" ]; then
            echo "::error::Deployment was rolled back. Running $RUNNING, expected $TASK_DEF"
            exit 1
          fi
          echo "Deployed $TASK_DEF"

      - name: Post-deploy smoke test
        run: |
          ALB=$(aws elbv2 describe-load-balancers --names hbc-alb \
            --query 'LoadBalancers[0].DNSName' --output text)
          curl -fsS "http://$ALB/health"
          curl -fsS "http://$ALB/api/v1/hbc/catalog/services" > /dev/null
          echo "Smoke test passed: http://$ALB"
```

### 5.4 Understand every stage

| Stage | What can go wrong that it catches |
|---|---|
| `npm ci` | Lockfile out of sync with `package.json` |
| `typecheck` | Type errors |
| `build` | Compile errors, migrations not copied |
| Migrate an empty DB | A broken SQL migration, *before* it touches RDS |
| `docker build` | Dockerfile errors, missing files in the build context |
| Container smoke test | App crashes on start in production mode, bad env validation, `/health` or a DB route broken |
| OIDC login | Wrong role or trust policy |
| Push with SHA tag | Every deploy is traceable to a commit; ECR rejects re-pushing the same tag |
| Register revision | Invalid task definition JSON |
| Migration task | Migration fails against the real DB → **stop before shipping code that needs it** |
| `update-service` + wait | New tasks fail health checks → circuit breaker rolls back → the job fails red |
| Smoke test | The public path through the ALB works |

### 5.5 Migrations and zero-downtime: the expand/contract rule

During a rolling deploy, **old and new code run at the same time** against the **new** schema (migrations ran first). So each migration must be compatible with the *previous* version of the code:

- ✅ Add a table, add a nullable column, add an index → safe.
- ❌ Rename or drop a column the old code still uses → old tasks start failing mid-deploy.
- Do it in two releases: **expand** (add the new column, write to both) → deploy → **contract** (drop the old column) → deploy.

Note that `src/db/migrate.ts` runs each file in a transaction, so a failing migration leaves no half-applied file.

### 5.6 Your first pipeline run

```bash
git checkout -b add-pipeline
git add Dockerfile .dockerignore docker-compose.yml .aws/task-definition.json .github/workflows/ci-cd.yml
git commit -m "Add container build and ECS deployment pipeline"
git push -u origin add-pipeline
```

1. Open a pull request. Only the `ci` job runs. Watch every step.
2. Merge it. `ci` runs again, then `deploy` (approve it if you added reviewers).
3. While it deploys, watch **ECS → Clusters → hbc → Services → hbc-api → Deployments** and **Events**. You'll see the new task start, become healthy, get registered in the target group, then the old one drain and stop.

---

## Part 6 — Deployment strategies and rollback

### 6.1 Rolling update (what you have)

With `minimumHealthyPercent=100` and `maximumPercent=200`, ECS starts the new tasks, waits until the ALB says they're healthy, then drains and stops the old ones.

```
time ─────────────────────────────────────────────────►
old v1  ████████████████████░░░░ (draining 30 s) stop
new v2            start ─ health checks ─ ██████████████
```

### 6.2 Deployment circuit breaker

If new tasks fail to start or fail health checks repeatedly, ECS marks the deployment `FAILED` and (with `rollback=true`) redeploys the last revision that completed. You'll trigger it on purpose in Lab 2.

### 6.3 Manual rollback

Every deploy is a task definition revision pointing at an immutable image. To roll back, point the service at an older revision:

```bash
aws ecs list-task-definitions --family-prefix hbc-api --sort DESC --max-items 5
aws ecs update-service --cluster hbc --service hbc-api --task-definition hbc-api:7
aws ecs wait services-stable --cluster hbc --services hbc-api
```

Or `git revert` the bad commit and let the pipeline deploy it, which keeps Git as the source of truth. Remember that **database migrations do not roll back**, which is another reason to follow expand/contract.

### 6.4 Other strategies (to study next)

| Strategy | How | When |
|---|---|---|
| **Blue/green** | Two target groups; ECS shifts traffic to the new (green) tasks at once or gradually, keeping blue for instant rollback. ECS now supports this natively (`deploymentConfiguration.strategy = BLUE_GREEN`); the older route is CodeDeploy | Lower risk, instant rollback |
| **Canary / linear** | Shift 10% of traffic, watch alarms, then the rest | High-traffic services |
| **Environments** | `staging` service + `production` service, same image promoted between them | Teams; run the Postman e2e collection against staging, not production |

---

## Part 7 — Observability

### 7.1 Logs: CloudWatch Logs and Logs Insights

Every line the app writes to stdout/stderr lands in log group `/ecs/hbc-api`, stream `api/hbc-api/<task-id>`.

Tail logs live from your terminal:

```bash
aws logs tail /ecs/hbc-api --follow --since 10m
aws logs tail /ecs/hbc-api --follow --filter-pattern '"[payments]"'
```

**Logs Insights** (CloudWatch → Logs → Logs Insights → choose `/ecs/hbc-api`) queries logs like a database:

```sql
-- Most recent errors and payment events
fields @timestamp, @logStream, @message
| filter @message like /payments|Error|Invalid environment/
| sort @timestamp desc
| limit 50
```

```sql
-- Startup lines: one per task start. Many in a short time = crash loop.
fields @timestamp, @logStream
| filter @message like /listening on/
| stats count() by bin(5m)
```

### 7.2 Make the logs structured (a code exercise worth doing)

Right now there is no log line per HTTP request, so you can't answer *"which endpoint is slow?"* or *"how many 500s on /pay?"* from the logs. Add a small JSON request logger. JSON lines are parsed by Logs Insights automatically, so every field becomes queryable.

Create `src/middleware/requestLog.ts`:

```ts
import crypto from 'node:crypto';
import { RequestHandler } from 'express';

/** One JSON line per request. CloudWatch Logs Insights turns each key into a queryable field. */
export const requestLog: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  const header = req.headers['x-request-id'];
  const requestId = typeof header === 'string' && header ? header : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    if (req.originalUrl === '/health') return; // health checks every 15 s are noise
    console.log(
      JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        msg: 'request',
        requestId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        role: req.headers['x-role'],
      }),
    );
  });
  next();
};
```

Register it first in `src/app.ts`, right after `helmet()`:

```ts
import { requestLog } from './middleware/requestLog';
// ...
app.use(requestLog);
```

Push through the pipeline, generate some traffic, then query:

```sql
-- Requests and error rate per minute
filter msg = "request"
| stats count() as requests,
        sum(status >= 500) as errors_5xx,
        sum(status >= 400 and status < 500) as errors_4xx
  by bin(1m)
```

```sql
-- Slowest endpoints (p95 / p99 latency)
filter msg = "request"
| stats count() as n, avg(durationMs) as avg_ms, pct(durationMs, 95) as p95_ms, pct(durationMs, 99) as p99_ms
  by method, path
| sort p95_ms desc
| limit 20
```

```sql
-- Follow one request end to end
filter requestId = "paste-a-request-id-here"
```

(For a production-grade logger, look at `pino` + `pino-http`; the idea is the same.)

### 7.3 Metrics you get for free

| Source | Namespace | Key metrics |
|---|---|---|
| ECS service | `AWS/ECS` | `CPUUtilization`, `MemoryUtilization` |
| Container Insights | `ECS/ContainerInsights` | `RunningTaskCount`, `DesiredTaskCount`, `PendingTaskCount`, CPU/memory per task, network, `RestartCount` |
| ALB | `AWS/ApplicationELB` | `RequestCount`, `TargetResponseTime`, `HTTPCode_Target_5XX_Count`, `HTTPCode_Target_4XX_Count`, `HTTPCode_ELB_5XX_Count`, `HealthyHostCount`, `UnHealthyHostCount` |
| RDS | `AWS/RDS` | `CPUUtilization`, `DatabaseConnections`, `FreeStorageSpace`, `ReadLatency`, `WriteLatency` |

- `HTTPCode_Target_5XX` = **your app** returned 5xx.
- `HTTPCode_ELB_5XX` = **the ALB** returned 5xx itself, usually `502`/`503` because there were no healthy targets.

### 7.4 Custom metrics from logs (metric filters)

Turn important log lines into metrics you can alarm on:

```bash
# Every "[payments] ..." error line becomes a count in HBC/PaymentErrors
aws logs put-metric-filter --log-group-name /ecs/hbc-api \
  --filter-name payment-errors \
  --filter-pattern '?"payment-service unreachable" ?"AMOUNT MISMATCH" ?"DOUBLE PAYMENT" ?"intent does not match"' \
  --metric-transformations metricName=PaymentErrors,metricNamespace=HBC,metricValue=1,defaultValue=0

# A paid booking that was already cancelled: someone must refund it
aws logs put-metric-filter --log-group-name /ecs/hbc-api \
  --filter-name refund-required \
  --filter-pattern '"REFUND REQUIRED"' \
  --metric-transformations metricName=RefundRequired,metricNamespace=HBC,metricValue=1,defaultValue=0

# After adding the JSON request logger (7.2): count 5xx by JSON field
aws logs put-metric-filter --log-group-name /ecs/hbc-api \
  --filter-name app-5xx \
  --filter-pattern '{ $.msg = "request" && $.status >= 500 }' \
  --metric-transformations metricName=App5xx,metricNamespace=HBC,metricValue=1,defaultValue=0
```

### 7.5 Alarms → email

```bash
export TOPIC_ARN=$(aws sns create-topic --name hbc-alerts --query TopicArn --output text)
aws sns subscribe --topic-arn $TOPIC_ARN --protocol email --notification-endpoint <your-email>
# Click the confirmation link in the email.

export ALB_DIM=$(echo $ALB_ARN | sed 's|.*:loadbalancer/||')     # app/hbc-alb/xxxx
export TG_DIM=$(echo $TG_ARN | sed 's|.*:||')                    # targetgroup/hbc-api-tg/xxxx

# 1) App is returning 5xx
aws cloudwatch put-metric-alarm --alarm-name hbc-target-5xx \
  --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$ALB_DIM \
  --statistic Sum --period 60 --evaluation-periods 3 --datapoints-to-alarm 2 \
  --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions $TOPIC_ARN --ok-actions $TOPIC_ARN

# 2) No healthy tasks behind the ALB (the site is down)
aws cloudwatch put-metric-alarm --alarm-name hbc-no-healthy-hosts \
  --namespace AWS/ApplicationELB --metric-name HealthyHostCount \
  --dimensions Name=LoadBalancer,Value=$ALB_DIM Name=TargetGroup,Value=$TG_DIM \
  --statistic Minimum --period 60 --evaluation-periods 2 \
  --threshold 1 --comparison-operator LessThanThreshold \
  --treat-missing-data breaching --alarm-actions $TOPIC_ARN --ok-actions $TOPIC_ARN

# 3) Slow responses (p95 latency over 1 s)
aws cloudwatch put-metric-alarm --alarm-name hbc-p95-latency \
  --namespace AWS/ApplicationELB --metric-name TargetResponseTime \
  --dimensions Name=LoadBalancer,Value=$ALB_DIM \
  --extended-statistic p95 --period 60 --evaluation-periods 5 --datapoints-to-alarm 3 \
  --threshold 1 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching --alarm-actions $TOPIC_ARN

# 4) CPU saturation
aws cloudwatch put-metric-alarm --alarm-name hbc-cpu-high \
  --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=hbc Name=ServiceName,Value=hbc-api \
  --statistic Average --period 60 --evaluation-periods 5 \
  --threshold 80 --comparison-operator GreaterThanThreshold \
  --alarm-actions $TOPIC_ARN

# 5) Payment errors (business signal)
aws cloudwatch put-metric-alarm --alarm-name hbc-payment-errors \
  --namespace HBC --metric-name PaymentErrors \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions $TOPIC_ARN

# 6) A refund is needed
aws cloudwatch put-metric-alarm --alarm-name hbc-refund-required \
  --namespace HBC --metric-name RefundRequired \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions $TOPIC_ARN
```

Alarm design rules:

- **Alert on symptoms users feel** (5xx, latency, site down) first; causes (CPU) second.
- **`datapoints-to-alarm` (M of N)** avoids paging on one blip.
- **`treat-missing-data`**: `notBreaching` for error counts (no data = no errors); `breaching` for "healthy hosts" (no data = probably down).
- Every alarm should have an obvious next step. Write it in the alarm description.

### 7.6 A dashboard

CloudWatch → **Dashboards → Create dashboard `hbc`**. Add widgets:

| Row | Widgets |
|---|---|
| Traffic | ALB `RequestCount` (sum, 1 min), `HTTPCode_Target_4XX/5XX_Count` |
| Latency | ALB `TargetResponseTime` p50 / p95 / p99 |
| Capacity | ECS `CPUUtilization`, `MemoryUtilization`; Container Insights `RunningTaskCount` vs `DesiredTaskCount` |
| Health | ALB `HealthyHostCount` / `UnHealthyHostCount` |
| Database | RDS `CPUUtilization`, `DatabaseConnections` |
| Business | `HBC/PaymentErrors`, `HBC/RefundRequired` |
| Logs | A Logs Insights widget with the "requests per minute by status" query |
| Alarms | An alarm status widget with all `hbc-*` alarms |

This is the **RED method** (Rate, Errors, Duration) for the service plus the **USE method** (Utilisation, Saturation, Errors) for resources.

### 7.7 Autoscaling

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/hbc/hbc-api --min-capacity 1 --max-capacity 4

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/hbc/hbc-api --policy-name cpu-60 \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 60,
    "PredefinedMetricSpecification": { "PredefinedMetricType": "ECSServiceAverageCPUUtilization" },
    "ScaleOutCooldown": 60,
    "ScaleInCooldown": 300
  }'
```

Watch out: each task opens its own `pg` pool (10 connections by default). 4 tasks × 10 = 40 connections, and `db.t4g.micro` allows roughly 80. Scaling the app can exhaust the database. Watch `DatabaseConnections`.

### 7.8 Tracing (stretch goal)

Traces show one request's path across services, e.g. *app → HBC → payment-service → Razorpay*, with timing for each hop and each SQL query.

Path to try once the basics work:

1. Add OpenTelemetry auto-instrumentation for Node (`@opentelemetry/auto-instrumentations-node`, which instruments `express`, `http` and `pg`).
2. Add the **AWS Distro for OpenTelemetry (ADOT) collector** as a sidecar container in the task definition, exporting to **AWS X-Ray**.
3. Give the **task role** `AWSXrayWriteOnlyAccess`.
4. Or enable **CloudWatch Application Signals**, which builds service maps and SLOs on top of the same data.

---

## Part 8 — Observability practice labs

Do these in order. For each: **predict** what you'll see, **do it**, **observe** in the console, then **explain** it in your own words. Keep a short incident note per lab (what happened, how you noticed, how you fixed it).

Useful commands for all labs:

```bash
aws ecs describe-services --cluster hbc --services hbc-api \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,deployments:deployments[].{status:status,rollout:rolloutState,td:taskDefinition,running:runningCount}}'
aws ecs describe-services --cluster hbc --services hbc-api --query 'services[0].events[:10].[createdAt,message]' --output table
aws ecs list-tasks --cluster hbc --service-name hbc-api --desired-status STOPPED
aws ecs describe-tasks --cluster hbc --tasks <task-arn> --query 'tasks[0].{stopped:stoppedReason,exit:containers[0].exitCode,reason:containers[0].reason}'
aws logs tail /ecs/hbc-api --follow
```

### Lab 1: Trace a deploy end to end

**Do:** Change the `/health` response in `src/app.ts` to `{ status: 'ok', version: process.env.APP_VERSION }`, add `APP_VERSION` to the task definition environment, merge.
**Observe:** the GitHub Actions log, the ECR image with the commit SHA tag, the new task definition revision, the service **Events** tab, the target group **Targets** tab (new IP goes `initial` → `healthy`, old IP `draining`), and `curl /health` switching versions.
**Learn:** what a rolling deployment really looks like, and how long each phase takes.

### Lab 2: Bad config → crash loop → automatic rollback

**Do:** In `.aws/task-definition.json`, delete the `PAYMENT_SERVICE_URL` entry. Merge.
**Predict:** `env.ts` requires it in production, so the process exits at once.
**Observe:**
- CloudWatch logs: `Invalid environment configuration: PAYMENT_SERVICE_URL required in production`.
- Stopped tasks with `exitCode: 1`, `Essential container in task exited`.
- Service events: the circuit breaker triggers, the deployment goes `FAILED`, and ECS rolls back.
- The pipeline turns red at the "rolled back" check, while the site **stays up** on the old revision.

**Fix:** restore the variable, merge. **Learn:** fail-fast config + circuit breaker = bad deploys don't cause outages.

### Lab 3: Self-healing

**Do:** Kill the running task.

```bash
TASK=$(aws ecs list-tasks --cluster hbc --service-name hbc-api --query 'taskArns[0]' --output text)
aws ecs stop-task --cluster hbc --task $TASK --reason "Lab 3 chaos"
```

**Observe:** with `desired-count 1`, the site is down for a short time (`HealthyHostCount` drops to 0, ALB returns `503`, the `hbc-no-healthy-hosts` alarm may fire). ECS starts a replacement.
**Then:** set `desired-count 2` and repeat. No downtime this time.
**Learn:** why production services run at least 2 tasks in different AZs.

### Lab 4: Failing health check

**Do:** Temporarily change the target group health check path to `/healthz` (a route that returns 404):

```bash
aws elbv2 modify-target-group --target-group-arn $TG_ARN --health-check-path /healthz
```

**Observe:** targets go `unhealthy` (reason `Target.ResponseCodeMismatch`), ECS replaces tasks again and again, `UnHealthyHostCount` rises, alarms fire, the ALB returns `502/503`.
**Fix:** set it back to `/health`. **Learn:** the difference between the **container** health check (in the task definition) and the **ALB** health check (in the target group), and that both can kill tasks.

### Lab 5: Load test, metrics and autoscaling

**Do:** Enable autoscaling (7.7), then generate load against a DB-backed public route for ~10 minutes. Any load tool works, for example:

```bash
npx autocannon -c 50 -d 600 http://<ALB_DNS>/api/v1/hbc/catalog/services
```

(Or use the Postman CLI's performance runner with the collection in `postman/`.)
**Observe:** ALB `RequestCount` and `TargetResponseTime`, ECS `CPUUtilization` crossing 60%, autoscaling activity (**Service → Auto Scaling → Activity**), `RunningTaskCount` going up, then RDS `DatabaseConnections`. After the test, watch it scale back in after the cooldown.
**Learn:** the p95 latency vs CPU relationship, and where the next bottleneck is (often the database).

### Lab 6: Database outage, and liveness vs readiness

**Do:** Stop the database: `aws rds stop-db-instance --db-instance-identifier hbc-db`.
**Predict:** `/health` doesn't touch the DB, so…
**Observe:** `/health` still returns `200`, the tasks stay "healthy", but `/api/v1/hbc/catalog/services` returns `500` and the logs show connection errors. The `hbc-target-5xx` alarm fires; `hbc-no-healthy-hosts` does **not**.
**Discuss:** should `/health` check the DB? If it did, a DB outage would make ECS kill and restart every task (which doesn't help, and adds a reconnect storm). A common pattern: keep `/health` as **liveness** (process alive) and add a separate **readiness** endpoint (e.g. `/ready` running `SELECT 1`) for dashboards and synthetic checks.
**Fix:** `aws rds start-db-instance --db-instance-identifier hbc-db`. (A stopped RDS instance restarts by itself after 7 days.)

### Lab 7: Log-based business alarm

**Do:** Make HBC unable to reach payment-service: point `PAYMENT_SERVICE_URL` at an unreachable address (e.g. `http://10.255.255.1:8083`), deploy, then create a booking and call `POST /patient/bookings/:id/pay` for a `CONFIRMED` booking (use the Postman collection with `baseUrl` = your ALB and `gatewaySecret` = your secret).
**Observe:** `[payments] payment-service unreachable` in the logs, the `HBC/PaymentErrors` metric, the `hbc-payment-errors` alarm email.
**Learn:** infrastructure metrics alone would have shown nothing wrong here. Business-level signals from logs catch it.

### Lab 8: Debug inside a running container (ECS Exec)

Install the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) locally (CloudShell already has it), then:

```bash
TASK=$(aws ecs list-tasks --cluster hbc --service-name hbc-api --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster hbc --task $TASK --container hbc-api --interactive --command "/bin/sh"
# inside:
node -e "fetch('http://localhost:4000/health').then(r=>r.text()).then(console.log)"
node -e "require('pg');const {Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query('select count(*) from schema_migrations').then(r=>{console.log(r.rows);process.exit(0)})"
```

**Learn:** how to check network reachability and env vars from the task's point of view. (ECS Exec sessions are themselves logged; in production, restrict who can use them.)

### Lab 9: Manual rollback drill

**Do:** Merge a harmless change, then roll back to the previous revision with `aws ecs update-service --task-definition hbc-api:<previous>` (6.3). Time it.
**Then:** do the same with `git revert` through the pipeline. Compare speed and traceability.
**Learn:** have a rollback you've practised *before* you need it.

### Lab 10: Build the dashboard and write a runbook

**Do:** Build the dashboard from 7.6. For each alarm in 7.5, write a short runbook entry: *what it means, first three things to check, how to fix*. Save it as `docs/RUNBOOK.md`.
**Then:** have a friend break something from Labs 2–7 without telling you which, and use only the dashboard, logs and alarms to find it.

---

## Part 9 — Cost and cleanup

### Rough monthly cost (ap-south-1, always on, as of late 2026; check the AWS pricing pages)

| Resource | Approx. / month |
|---|---|
| Fargate 0.25 vCPU / 0.5 GB × 1 task | ~$9–10 |
| Application Load Balancer | ~$17–20 |
| RDS db.t4g.micro + 20 GB gp3 | ~$13–16 (free tier may cover it for new accounts) |
| Public IPv4 addresses (ALB + tasks) | ~$3.60 each |
| Secrets Manager (1 secret) | ~$0.40 |
| CloudWatch logs, metrics, alarms, Container Insights | a few $ at this scale |
| **Total** | **roughly $45–60 / month** |

To save money between study sessions: scale the service to 0 (`aws ecs update-service --cluster hbc --service hbc-api --desired-count 0`) and stop RDS. The ALB still costs money while it exists.

### Delete everything (in this order)

```bash
aws application-autoscaling deregister-scalable-target --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount --resource-id service/hbc/hbc-api 2>/dev/null

aws ecs update-service --cluster hbc --service hbc-api --desired-count 0
aws ecs delete-service --cluster hbc --service hbc-api --force
aws ecs wait services-inactive --cluster hbc --services hbc-api
aws ecs delete-cluster --cluster hbc

aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws elbv2 wait load-balancers-deleted --load-balancer-arns $ALB_ARN
aws elbv2 delete-target-group --target-group-arn $TG_ARN

aws rds delete-db-instance --db-instance-identifier hbc-db --skip-final-snapshot
aws rds wait db-instance-deleted --db-instance-identifier hbc-db

aws ec2 delete-security-group --group-id $DB_SG
aws ec2 delete-security-group --group-id $APP_SG
aws ec2 delete-security-group --group-id $ALB_SG

aws ecr delete-repository --repository-name hbc-api --force
aws secretsmanager delete-secret --secret-id hbc/prod --force-delete-without-recovery
aws logs delete-log-group --log-group-name /ecs/hbc-api
aws cloudwatch delete-alarms --alarm-names hbc-target-5xx hbc-no-healthy-hosts hbc-p95-latency hbc-cpu-high hbc-payment-errors hbc-refund-required
aws sns delete-topic --topic-arn $TOPIC_ARN

for r in hbc-ecs-execution-role hbc-ecs-task-role hbc-github-deploy-role; do
  for p in $(aws iam list-role-policies --role-name $r --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name $r --policy-name $p; done
  for a in $(aws iam list-attached-role-policies --role-name $r --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name $r --policy-arn $a; done
  aws iam delete-role --role-name $r
done
```

Task definition revisions cost nothing; you can deregister them in the console if you want a clean list. Finally, check **Billing → Bills** the next day to confirm nothing is still charging.

---

## Part 10 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Task stops with `CannotPullContainerError` / `ResourceInitializationError: ... ecr` | The task can't reach ECR: no public IP in a public subnet, or private subnet without NAT/endpoints | `assignPublicIp=ENABLED` with public subnets, or add a NAT gateway / VPC endpoints |
| `ResourceInitializationError: unable to pull secrets` | Execution role lacks `secretsmanager:GetSecretValue` on that ARN, wrong JSON key, or no network path to Secrets Manager | Check the role policy and `valueFrom` (full ARN + `:KEY::`) |
| Task exits with code `1` within seconds | `env.ts` rejected the config | Read the first log lines in `/ecs/hbc-api` |
| `exec format error` | Image built for arm64, task is X86_64 (or vice versa) | `docker build --platform linux/amd64`, or set `runtimePlatform` to `ARM64` |
| Targets `unhealthy`, `Target.Timeout` | App SG doesn't allow 4000 from the ALB SG | Fix the `hbc-app-sg` ingress rule |
| Targets `unhealthy`, `Target.ResponseCodeMismatch` | Health check path wrong | Must be `/health` |
| ALB returns `503` | No registered healthy targets | Look at service events and stopped tasks |
| App logs `connect ETIMEDOUT ...:5432` | DB SG doesn't allow the app SG, or wrong host | Fix `hbc-db-sg` ingress |
| `self-signed certificate in certificate chain` | `node-postgres` doesn't trust the RDS CA | Use the Dockerfile's CA bundle and `sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem` |
| `no pg_hba.conf entry ... no encryption` | Connecting to RDS without TLS | Add the `sslmode` parameters above |
| `password authentication failed` | Special characters in the password weren't URL-encoded | Use an alphanumeric password or `encodeURIComponent` it in `DATABASE_URL` |
| GitHub: `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Trust policy `sub` doesn't match (environment vs branch), wrong repo name, or missing `id-token: write` | Compare against 5.1 |
| GitHub: `AccessDenied ... iam:PassRole` | Deploy role lacks PassRole on the execution/task roles | Add it (5.1) |
| `aws ecs wait services-stable` times out | Tasks keep failing; the waiter stops after 10 minutes | Read service events and stopped task reasons |
| Pipeline green, but old code is still running | You used `services-stable` without checking for rollback | Keep the "PRIMARY deployment = new revision" check |
| `401 Request did not come through the gateway` | `X-Gateway-Secret` missing or wrong | Send the value stored in `hbc/prod` → `GATEWAY_SHARED_SECRET` |
| `npm ci` fails in Docker on missing native binary | Lockfile generated without the Linux optional dependency | Run `npm install` once and commit the updated `package-lock.json`, or build on Linux |

---

## Where to go next

1. **Infrastructure as Code:** rebuild Part 4 with Terraform or AWS CDK, and add a `staging` environment from the same code.
2. **HTTPS and a domain:** Route 53 + ACM certificate on the ALB.
3. **Private networking:** move tasks to private subnets with VPC endpoints; make the ALB internal behind the Uyir API gateway.
4. **Service-to-service:** ECS Service Connect between the gateway, HBC and payment-service.
5. **Security scanning in CI:** fail the build on critical CVEs from ECR scans or Trivy; `npm audit`.
6. **SLOs:** define "99.5% of requests succeed in under 500 ms" and alert on error budget burn rate instead of raw thresholds.
