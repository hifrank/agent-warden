# Agent Warden — Security Approaches

> Overview of security domains, techniques, and components used in the Agent Warden platform.
> For full implementation details, see [secure-multi-tenant-openclaw.md](secure-multi-tenant-openclaw.md).

---

## 1. Tenant Isolation

Each tenant operates in a fully isolated environment with no shared state, secrets, or network paths.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Namespace isolation | Dedicated K8s namespace (`tenant-<id>`) per tenant with separate PID/mount/user namespaces | Helm chart, K8s Operator |
| NetworkPolicy (default-deny) | All ingress/egress denied by default; only DNS (53) and HTTPS (443) egress permitted; ingress only from AGC subnet | [networkpolicy.yaml](../../k8s/helm/openclaw-tenant/templates/networkpolicy.yaml) |
| ResourceQuota + LimitRange | Per-tier CPU/memory/storage/pod limits enforced at namespace level | [resourcequota.yaml](../../k8s/helm/openclaw-tenant/templates/resourcequota.yaml) |
| Dedicated Key Vault | Per-tenant Azure Key Vault (HSM Premium) — tenants cannot access other tenants' secrets | Terraform [keyvault](../../infra/terraform/modules/keyvault/main.tf) |
| Per-tenant Managed Identity | Workload Identity with federated credentials scoped to tenant namespace and service account | Terraform [managed-identity](../../infra/terraform/modules/managed-identity/main.tf) |
| Node pool separation | 3-pool architecture with taints: system (control plane), tenant (gateway pods), sandbox (Kata microVMs) | Terraform [aks](../../infra/terraform/modules/aks/main.tf) |

### Design doc reference: §4.1, §15.2

---

## 2. Network Security

Defense at L3/L4/L7 with zero-trust network posture.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Calico NetworkPolicy | `network_policy = "calico"` on AKS for K8s-native policy enforcement | Terraform AKS module |
| VNet subnet segmentation | Separate subnets for AKS nodes, Application Gateway, and private endpoints | Terraform [vnet](../../infra/terraform/modules/vnet/main.tf) |
| NSG on AKS subnet | Network Security Group with layer-4 filtering on the AKS node subnet | Terraform VNet module |
| Private endpoints | Key Vault, Cosmos DB, ACR, Log Analytics accessed only via private endpoints (no public exposure) | Terraform PE subnet |
| WAF (OWASP 3.2) | Application Gateway for Containers with OWASP Core Rule Set 3.2 and Bot Manager rules | Terraform [appgw](../../infra/terraform/modules/appgw/main.tf) |
| TLS termination | All ingress via AGC with TLS; internal traffic within VNet | AGC configuration |
| SaaS proxy route policies | Per-provider deny/allow rules at the API path level — blocks unauthorized SaaS operations | [proxy.ts](../../agent-warden-saas-proxy/src/proxy.ts) |

### Design doc reference: §4.2, §15.2

---

## 3. Identity & Access Management

Zero-trust identity model with no static credentials in containers.

| Technique | Description | Component |
|-----------|-------------|-----------|
| AKS Workload Identity | OIDC federation between K8s service accounts and Azure Managed Identities — no static secrets | [serviceaccount.yaml](../../k8s/helm/openclaw-tenant/templates/serviceaccount.yaml) |
| Entra ID RBAC on AKS | `azure_rbac_enabled = true` with admin security group bound to K8s cluster-admin | Terraform AKS module |
| 5-role RBAC model | `tenant:owner`, `tenant:admin`, `tenant:viewer`, `platform:operator`, `platform:security` — operators cannot access tenant secrets | Agent Warden Server |
| Conditional Access | MFA required, device compliance checks, legacy auth blocking, named location restrictions | Entra ID |
| Privileged Identity Management (PIM) | Just-in-time access for platform operators, time-boxed role activation, approval workflows for KEK operations | Entra ID PIM |
| Operator least-privilege ClusterRole | Operator SA scoped to only namespaces, statefulsets, networkpolicies, secretproviderclasses, CRDs | [operator-rbac.yaml](../../k8s/base/rbac/operator-rbac.yaml) |
| CI/CD OIDC federation | GitHub Actions use federated credentials (no static Azure secrets in repos) | App Registration + GitHub OIDC |

### Design doc reference: §5, §15.3

---

## 4. Secrets & Credential Management

3-tier envelope encryption with HSM-backed key hierarchy.

| Technique | Description | Component |
|-----------|-------------|-----------|
| HSM-backed Key Vault (Premium) | FIPS 140-2 Level 3, `purge_protection_enabled`, `soft_delete_retention_days = 90`, RBAC authorization | Terraform [keyvault](../../infra/terraform/modules/keyvault/main.tf) |
| 3-tier envelope encryption | HSM Master Key → Per-Tenant KEK → Per-Secret DEK | Key Vault + Agent Warden Server |
| Secrets Store CSI Driver | Secrets injected from Key Vault into pods via SecretProviderClass — auto-rotation every 5 minutes | [secretproviderclass.yaml](../../k8s/helm/openclaw-tenant/templates/secretproviderclass.yaml) |
| Key rotation policies | API keys: 90-day auto-rotation; channel tokens: on-demand; KEKs: annual with dual-key window | Key Vault rotation policy |
| No secrets in sandbox pods | Sandbox pods have zero Secret mounts, no SecretProviderClass, `automountServiceAccountToken: false` | [sandbox.yaml](../../k8s/helm/openclaw-tenant/templates/sandbox.yaml) |
| Deny-default Key Vault network ACL | Key Vault network rule defaults to `Deny`; only VNet and private endpoints allowed | Terraform keyvault module |

### Design doc reference: §6

---

## 5. Data Loss Prevention (DLP)

4-layer defense-in-depth via Microsoft Purview processContent API.

| Layer | Hook | Action | Mode |
|-------|------|--------|------|
| **L0** | Azure OpenAI content filter | Model-level PII blocking (built-in to Azure OpenAI) | Always active |
| **L1: Prompt Guard** | `before_agent_start` | Injects DLP security policy into agent context — instructs LLM to never output raw PII | Enforce + Audit |
| **L2: Output Scanner** | `tool_result_persist` | Scans tool output via Purview `processContent(spawnSync+curl)`; redacts blocked content before LLM sees it | Enforce: sync redact / Audit: async log |
| **L2b: Response Scanner** | `message_sending` | Scans outbound LLM response via Purview; replaces with DLP notice if blocked. Requires Telegram streaming OFF | Enforce only |
| **L3: Input Audit** | `message_received` | Audits inbound user messages via Purview — detection + logging | Enforce + Audit |

**Dual-mode operation:**

| Mode | Streaming | L2 Behavior | L2b | Use Case |
|------|-----------|-------------|-----|----------|
| `enforce` (default) | OFF | Sync block + redact | Active | Production — blocks PII at every exit point |
| `audit` | ON (partial) | Async log only | Not registered | Monitoring — logs violations without blocking |

**Cross-tenant architecture:** The DLP plugin authenticates to a separate Microsoft 365 E5 tenant via `ClientSecretCredential` (multi-tenant app registration) to evaluate content against centralized DLP policies.

**Purview integration requirements:**
- DLP policy with `-GenerateAlert` and `-GenerateIncidentReport` for portal alerts
- DSPM for AI collection policy (KYD) with ingestion enabled
- Unified Audit Log enabled on the E5 tenant

### Implementation: [purview-dlp-plugin.md](purview-dlp-plugin.md), [index.ts](../../agent-warden-purview-dlp/src/index.ts)
### Design doc reference: §16

---

## 6. Sandbox Security (Kata Containers)

Tool execution runs inside hardware-isolated Hyper-V microVMs.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Kata Containers (`kata-mshv-vm-isolation`) | Each tool execution pod runs in a Hyper-V microVM — hardware boundary between untrusted code and host kernel | RuntimeClass, Terraform AKS sandbox pool |
| Sandbox monitor (PID 1) | TypeScript process running as PID 1 inside the microVM; forks tool process and monitors its behavior | [monitor.ts](../../sandbox-monitor/src/monitor.ts) |
| Suspicious binary detection | Flags execution of `curl`, `wget`, `nc`, `nmap`, `ssh`, `python`, `perl`, and shell interpreters | Sandbox monitor |
| Suspicious file detection | Regex patterns for `.sh`, `.py`, `reverse.?shell`, `exploit`, `backdoor`, `payload`, `meterpreter` | Sandbox monitor |
| Network connection monitoring | Parses `/proc/net/tcp` to detect outbound connections, DNS queries, byte counts | Sandbox monitor |
| Risk scoring | Computed risk score with automated actions: `allow`, `flag`, or `alert` | Sandbox monitor |
| Pod hardening | `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, seccomp `RuntimeDefault` | [sandbox.yaml](../../k8s/helm/openclaw-tenant/templates/sandbox.yaml) |
| Ephemeral isolation | tmpfs-only volumes (`emptyDir` with `medium: Memory`), no PVCs, `activeDeadlineSeconds` timeout | Sandbox pod spec |
| Forced sandbox mode | All sessions run sandboxed (`sandbox.mode: "always"`) enforced by policy engine | Agent Warden Server |

### Design doc reference: §4.1.1

---

## 7. Audit & Observability

Comprehensive audit trail with tamper-proof storage and SIEM integration.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Structured audit events | 11+ event types: `tenant.created`, `secret.accessed`, `sandbox.exec`, `auth.failed`, `config.changed`, etc. | Agent Warden Server |
| Cosmos DB audit log | All operations logged with 90-day TTL | [cosmos.ts](../../agent-warden-server/src/middleware/cosmos.ts) |
| Log Analytics workspace | Centralized logging with per-tenant RBAC (tenants see only their own logs) | Terraform [log-analytics](../../infra/terraform/modules/log-analytics/main.tf) |
| Microsoft Sentinel SIEM | Ingests from Defender, Purview DLP, Entra ID, Key Vault for unified threat detection and correlation | Sentinel workspace |
| WORM audit trail | Azure Blob immutability policies with integrity checksums for tamper-proof regulatory compliance | Azure Blob Storage |
| Key Vault diagnostics | All `AuditEvent` category events streamed to Log Analytics | Terraform keyvault module |
| PII redaction in logs | Conversation content excluded from platform logs — only metadata; DLP enforces redaction | DLP plugin + log architecture |
| Security alerting | 10+ Sentinel alert rules for container escape, cross-tenant access, DLP blocks, brute-force auth, resource exhaustion | Sentinel analytics |

### Design doc reference: §9

---

## 8. Data Governance

4-layer data governance framework for SaaS API interactions.

| Layer | Scope | Description | Component |
|-------|-------|-------------|-----------|
| **L1: Activity Ledger** | Every SaaS API call | Logs operation, provider, resource, DLP status as `data.activity` events | [proxy.ts](../../agent-warden-saas-proxy/src/proxy.ts) |
| **L2: Data Lineage** | Data flow tracking | Source → agent processing → LLM enrichment → destination for each data flow | Cosmos DB governance container |
| **L3: Access Governance** | Permission tracking | Scope validation, delegated permission auditing, access reviews | Agent Warden Server MCP tools |
| **L4: Compliance Reporting** | Regulatory dashboards | Data residency verification, regulatory compliance reports | Log Analytics + Sentinel |

**Route classification** maps `(provider, method, path)` → `(operation, resourceType)` for semantic tracking of SaaS API activity (e.g., `GET /gmail/v1/users/me/messages` → `read, email`).

### Implementation: [data-governance.md](data-governance.md)
### Design doc reference: §18.7

---

## 9. Resource Governance (DoS Protection)

Per-tier limits prevent resource exhaustion and noisy-neighbor effects.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Per-tier ResourceQuota | CPU/memory/storage/pod limits: Free (1.5 CPU/3Gi), Pro (3/6Gi), Enterprise (6/12Gi) | [resourcequota.yaml](../../k8s/helm/openclaw-tenant/templates/resourcequota.yaml) |
| LimitRange defaults | Container default/max CPU + memory with per-tier scaling | ResourceQuota template |
| Rate limiting | Per-tenant (100 req/min), per-IP (50 req/min), global circuit breaker at 80% platform capacity | Ingress + Agent Warden Server |
| Noisy neighbor protection | CPU hard limits (cgroups), I/O bandwidth limits, network bandwidth limits (tc/eBPF), OOM killer integration | K8s resource limits |
| Sandbox timeout | `activeDeadlineSeconds` per sandbox pod, configurable per tier | Sandbox pod spec |

### Design doc reference: §8

---

## 10. Supply Chain Security

Managed skill installation with trust verification.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Skill allowlist | Platform Skill Gateway checks against allowlist before installing managed skills | Agent Warden Server |
| Signature verification | Managed skills require valid cryptographic signatures before installation | Agent Warden Server |
| CVE scanning | Skill npm dependencies scanned for known vulnerabilities before installation | Agent Warden Server |
| DLP scan on skill code | Skill source code + data scanned for embedded secrets or sensitive data | Purview + Agent Warden |
| ACR image scanning | Defender scans container images on push for CVEs, rescans continuously | Azure Defender + ACR |
| Container image content trust | ACR Premium with content trust for signed images | ACR configuration |

### Design doc reference: §17

---

## 11. Runtime Security (Microsoft Defender)

Real-time container and cluster security monitoring.

| Technique | Description | Component |
|-----------|-------------|-----------|
| Defender for Containers | eBPF-based DaemonSet on every AKS node — monitors process execution, file access, network, DNS, kernel modules | Terraform AKS addon (`microsoft_defender`) |
| Sentinel auto-response | Analytics rule triggers Logic App playbook → calls `warden.tenant.suspend` to isolate compromised tenant | Sentinel + Logic App |
| Binary drift detection | Detects new binaries executed at runtime that weren't in the original container image | Azure Defender |
| K8s manifest audit | Flags pods with insecure specs (privileged, hostPID, hostNetwork) | Azure Policy + Gatekeeper |

### Design doc reference: §15.5

---

## 12. Compliance & Disaster Recovery

Regulatory compliance controls and data protection.

| Technique | Description | Component |
|-----------|-------------|-----------|
| GDPR right to erasure | Crypto-shred via KEK deletion — all data encrypted under the tenant KEK becomes unrecoverable | Key Vault + delete-tenant.sh |
| SOC 2 Type II | Audit logging + access controls + encryption at rest/transit verified via Defender for Cloud compliance dashboard | Azure platform |
| HIPAA | Kata VM-based isolation, BAA support, encrypted PHI, sensitivity labels for PHI data | Azure + Purview labels |
| Data residency pinning | Per-tenant Azure region pinning via Azure Policy (allowed locations) | Azure Policy |
| Backup strategy | PVC snapshots every 6h (30-day GRS), session transcripts to Blob WORM (1yr), secrets in soft-delete Key Vault | Azure Backup + Blob |
| Azure Policy + OPA Gatekeeper | Pod security standards enforcement, allowed registries, required labels, network constraints | AKS addon |

### Design doc reference: §13, §14

---

## SaaS Auth Proxy Security

The SaaS Auth Proxy sidecar provides secure delegated access to external APIs.

| Technique | Description |
|-----------|-------------|
| OAuth token injection | Proxy injects OAuth access tokens on behalf of tenant — agent never sees raw refresh tokens |
| Token caching | In-memory cache with 1-minute early-expiry buffer to prevent expired token leaks |
| Refresh token rotation | Detects rotated refresh tokens from providers and writes to `.rotation/` for Key Vault sync |
| Secrets from CSI mount | All SaaS provider credentials loaded from Key Vault CSI-mounted paths (not env vars) |
| Per-request audit logging | Every SaaS API call logged with provider, method, path, status, duration, blocked status |

### Implementation: [proxy.ts](../../agent-warden-saas-proxy/src/proxy.ts)

---

## Security Architecture Diagram

See [architecture.excalidraw](architecture.excalidraw) and [purview-dlp-plugin.excalidraw](purview-dlp-plugin.excalidraw) for visual diagrams.

For the complete architecture document (4400+ lines), see [secure-multi-tenant-openclaw.md](secure-multi-tenant-openclaw.md).
