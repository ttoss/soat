# SOAT on AWS — Bring-up Runbook (Budget tier, guided CLI)

Manual `aws` CLI steps to stand up the budget-tier infrastructure. Stateful
stores (**S3**, **RDS**) are created here by hand and kept **out of Terraform**
so a future `terraform destroy` on the compute layer can never wipe data. The
disposable compute/networking (ECS, ALB, gateways) comes in later parts and may
be Terraform, referencing these resources by ID.

Run everything in **one shell session** so the exported IDs persist. Re-fetch
commands are at the bottom if you close the terminal.

## pgvector note

No manual `psql`/`CREATE EXTENSION` step is required. `packages/server/src/db.ts`
initializes with `createVectorExtension: true`, so the app runs
`CREATE EXTENSION vector` on first boot. The RDS master user holds
`rds_superuser`, which is permitted to create the `vector` trusted extension.
You only need an RDS Postgres version that ships pgvector (15.2+/16.x all do).

## VPC note

RDS requires a DB subnet group spanning ≥2 AZs, so Part 2 creates a minimal VPC
with two subnets. **The ECS layer reuses this same VPC** — RDS and ECS must
share a VPC to communicate over private IPs. RDS stays
`PubliclyAccessible=false`; its security-group ingress ("allow 5432 from the ECS
service SG") is added in the compute part.

---

## Prerequisites

```bash
aws --version                 # v2 recommended
aws sts get-caller-identity   # confirm the right account
export AWS_REGION=us-east-1    # change if desired
export SOAT_ENV=prod
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

---

## Part 1 — S3 bucket for files

```bash
export FILES_BUCKET="soat-files-${SOAT_ENV}-${ACCOUNT_ID}"   # globally unique

# Create the bucket (us-east-1 takes NO LocationConstraint)
aws s3api create-bucket --bucket "$FILES_BUCKET" --region "$AWS_REGION"
# For any OTHER region, use this form instead:
# aws s3api create-bucket --bucket "$FILES_BUCKET" --region "$AWS_REGION" \
#   --create-bucket-configuration LocationConstraint="$AWS_REGION"

# Block ALL public access
aws s3api put-public-access-block --bucket "$FILES_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Default encryption (SSE-S3) + bucket keys
aws s3api put-bucket-encryption --bucket "$FILES_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

# Versioning
aws s3api put-bucket-versioning --bucket "$FILES_BUCKET" \
  --versioning-configuration Status=Enabled

# Abort abandoned multipart uploads after 7 days
aws s3api put-bucket-lifecycle-configuration --bucket "$FILES_BUCKET" \
  --lifecycle-configuration \
  '{"Rules":[{"ID":"abort-incomplete-mpu","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'

echo "Files bucket: $FILES_BUCKET"
```

> ⚠️ The S3 storage backend is still a **code change** (the app writes to local
> disk today). This bucket sits idle until that code lands.

---

## Part 2 — RDS PostgreSQL (with the VPC it needs)

### 2a. Minimal VPC + subnets (reused by ECS later)

```bash
export VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=soat-vpc}]' \
  --query 'Vpc.VpcId' --output text)
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-support

export AZ1=$(aws ec2 describe-availability-zones --region $AWS_REGION \
  --query 'AvailabilityZones[0].ZoneName' --output text)
export AZ2=$(aws ec2 describe-availability-zones --region $AWS_REGION \
  --query 'AvailabilityZones[1].ZoneName' --output text)

export SUBNET1=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 \
  --availability-zone $AZ1 \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=soat-subnet-a}]' \
  --query 'Subnet.SubnetId' --output text)
export SUBNET2=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 \
  --availability-zone $AZ2 \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=soat-subnet-b}]' \
  --query 'Subnet.SubnetId' --output text)

echo "VPC=$VPC_ID  SUBNET1=$SUBNET1 ($AZ1)  SUBNET2=$SUBNET2 ($AZ2)"
```

### 2b. DB security group + subnet group

```bash
export DB_SG=$(aws ec2 create-security-group --group-name soat-db-sg \
  --description "SOAT RDS Postgres" --vpc-id $VPC_ID \
  --query 'GroupId' --output text)
# No ingress rule yet — added ("allow 5432 from ECS service SG") in the
# compute part. RDS is unreachable until then, which is correct.

aws rds create-db-subnet-group \
  --db-subnet-group-name soat-db-subnet-group \
  --db-subnet-group-description "SOAT DB subnets" \
  --subnet-ids $SUBNET1 $SUBNET2
```

### 2c. Pick a Postgres version that ships pgvector

```bash
aws rds describe-db-engine-versions --engine postgres \
  --query "DBEngineVersions[?starts_with(EngineVersion,'16.')].EngineVersion" \
  --output text
export PG_VERSION=16.8   # replace with the newest 16.x printed above
```

### 2d. Create the instance (budget: db.t4g.micro, single-AZ)

```bash
aws rds create-db-instance \
  --db-instance-identifier soat-db-${SOAT_ENV} \
  --engine postgres \
  --engine-version $PG_VERSION \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 \
  --storage-type gp3 \
  --storage-encrypted \
  --master-username soat_admin \
  --manage-master-user-password \
  --db-name soat \
  --vpc-security-group-ids $DB_SG \
  --db-subnet-group-name soat-db-subnet-group \
  --no-publicly-accessible \
  --no-multi-az \
  --backup-retention-period 7 \
  --tags Key=Name,Value=soat-db-${SOAT_ENV}

aws rds wait db-instance-available --db-instance-identifier soat-db-${SOAT_ENV}
```

> `--manage-master-user-password` stores and rotates the master password in
> **Secrets Manager** automatically — no plaintext password to handle.

### 2e. Capture outputs for later parts

```bash
export DB_HOST=$(aws rds describe-db-instances --db-instance-identifier soat-db-${SOAT_ENV} \
  --query 'DBInstances[0].Endpoint.Address' --output text)
export DB_SECRET_ARN=$(aws rds describe-db-instances --db-instance-identifier soat-db-${SOAT_ENV} \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)

echo "DB_HOST=$DB_HOST"
echo "DB_SECRET_ARN=$DB_SECRET_ARN"
echo "DB_NAME=soat  DB_USER=soat_admin  DB_PORT=5432"
```

---

## Values to keep for the next parts

| Variable | Used later for |
|---|---|
| `FILES_BUCKET` | S3 IAM policy on the ECS task role |
| `VPC_ID`, `SUBNET1`, `SUBNET2` | ECS service, ALB |
| `DB_SG` | "allow 5432 from service SG" ingress rule |
| `DB_HOST`, `DB_SECRET_ARN` | ECS task env / secrets |

## Re-fetch after closing the terminal

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=soat-vpc \
  --query 'Vpcs[0].VpcId' --output text)
export DB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=soat-db-sg \
  --query 'SecurityGroups[0].GroupId' --output text)
export DB_HOST=$(aws rds describe-db-instances --db-instance-identifier soat-db-prod \
  --query 'DBInstances[0].Endpoint.Address' --output text)
export SUBNET1=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=soat-subnet-a \
  --query 'Subnets[0].SubnetId' --output text)
export SUBNET2=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=soat-subnet-b \
  --query 'Subnets[0].SubnetId' --output text)
```

---

## Deferred to later parts

- Internet gateway + route tables (needed when ECS/ALB go in)
- ECS service security group + the DB ingress rule that pairs with it
- Secrets Manager entries for `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY`
- ECR repository / container image
- ECS cluster + task definition + service
- Application Load Balancer + listener + target group

## Teardown (when done testing)

```bash
aws rds delete-db-instance --db-instance-identifier soat-db-prod \
  --skip-final-snapshot --delete-automated-backups
aws s3 rb "s3://$FILES_BUCKET" --force    # deletes the bucket AND its contents
# VPC/subnets/SG: delete after the compute layer is torn down.
```
