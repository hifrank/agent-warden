#!/usr/bin/env pwsh
# Check DLP policy distribution status and optionally test processContent
# Usage: pwsh test/check-dlp-distribution.ps1 [-Test]

param(
    [switch]$Test,
    [switch]$Retry
)

Import-Module ExchangeOnlineManagement
Connect-IPPSSession

$policy = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII"
Write-Host "`n=== DLP Policy Distribution Status ==="
Write-Host "  Policy: $($policy.Name)"
Write-Host "  Mode: $($policy.Mode)"
Write-Host "  DistributionStatus: $($policy.DistributionStatus)"
Write-Host "  WhenChanged: $($policy.WhenChangedUTC)"

if ($policy.DistributionStatus -eq "Success") {
    Write-Host "`n  ✅ Policy is fully distributed!" -ForegroundColor Green
} else {
    Write-Host "`n  ⏳ Policy distribution is $($policy.DistributionStatus)" -ForegroundColor Yellow
    Write-Host "  DLP changes typically take 1-24 hours to propagate."

    if ($Retry) {
        Write-Host "`n  Forcing redistribution..."
        Set-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -RetryDistribution
        Write-Host "  RetryDistribution sent."
    }
}

if ($Test -and $policy.DistributionStatus -eq "Success") {
    Write-Host "`n  Run the test script to verify:"
    Write-Host '  export PURVIEW_DLP_CLIENT_SECRET="$(kubectl get secret openclaw-demo-tenant-secrets -n tenant-demo-tenant -o jsonpath=''{.data.PURVIEW_DLP_CLIENT_SECRET}'' | base64 -d)"'
    Write-Host '  PURVIEW_DLP_TENANT_ID=dab94ed2-4cee-4b36-b007-6618f570b4a3 PURVIEW_DLP_USER_ID=21bbd518-a20d-41a6-a5da-78e097fda3e5 node --experimental-strip-types test/test-dlp-scenarios-valid.ts'
}
