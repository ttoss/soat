# SOAT on AWS — Cost Tiers

Three ways to run the same architecture (ECS + ALB + PostgreSQL + S3). Moving
up a tier is resizing Terraform variables, not re-architecting.

| | **Budget** | **Middle** | **Standard** |
| --- | --- | --- | --- |
| **~USD/month** | **$70** | **$120–180** | **$300–600** |
| **When to use** | Launch / low traffic, brief outage acceptable | Cover the two likely failures cheaply | Production HA, no single point of failure |
| **Compute** | 1× t4g.medium (~$25) | 2× t4g.medium, one per AZ (~$50) | 2× m6i.large across AZs (~$140) |
| **Database** | RDS db.t4g.micro, single-AZ (~$14) | RDS db.t4g.small, Multi-AZ (~$47) | Aurora Serverless v2 writer + reader (~$90–350) |
| **Load balancer** | ALB (~$25) | ALB (~$25) | ALB (~$25) |
| **NAT gateway** | none — public subnets, SG locked to ALB (0) | none (0) | 1× NAT (~$35) |
| **VPC endpoints** | none (0) | none (0) | S3 / Bedrock / ECR / Logs (~$7 each) |
| **S3 + Secrets + CloudWatch** | ~$5 | ~$5 | ~$20–50 |
| **DB failure recovery** | restore from backup (min–hrs) | <60s Multi-AZ standby | <30s Aurora failover |
| **Instance failure** | downtime until ASG replaces (min) | survives — second AZ | survives — second AZ |
| **Network isolation** | public subnets, strict SGs | public subnets, strict SGs | private subnets + NAT |

## Notes

- **Graviton (`t4g`)** is ~20% cheaper than x86 and the server image is plain
  Node — build it multi-arch. Burstable instances fit the workload well since
  the server idles between LLM calls.
- **No NAT on budget/middle** is not a security compromise: tasks sit in public
  subnets with security groups that only allow inbound from the ALB. It saves
  ~$35/month plus data-processing charges. A `fck-nat` instance (t4g.nano,
  ~$3/mo) is the community-standard middle ground if private subnets are wanted
  cheaply.
- **The Standard-tier premium is almost entirely HA**: Aurora's dual instances
  and the NAT/endpoints are what push it from ~$70 to ~$300+. The application
  runs identically on the budget tier.

## Recommended path

Start on **Budget (~$70)**. Add the second-AZ instance and RDS Multi-AZ first
(that is the **Middle** tier, ~$150) — this removes the two most likely
outages. Move to **Standard** (Aurora + private subnets + NAT) only when
traffic justifies serverless autoscaling or when subnet isolation becomes a
compliance requirement.
