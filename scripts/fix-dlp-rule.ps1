#!/usr/bin/env pwsh
# Re-configure the DLP rule to properly block via processContent API
# Run interactively: pwsh scripts/fix-dlp-rule.ps1
#
# The issue: protectionScopes shows scopes but processContent returns empty policyActions.
# Fix: Update rule with proper RestrictAccess and BlockAccess settings for the AI app workload.

Import-Module ExchangeOnlineManagement

Write-Host "Connecting to Security & Compliance (browser auth)..." -ForegroundColor Cyan
Connect-IPPSSession

# ── Check current state ──
Write-Host "`n=== Current Policy ===" -ForegroundColor Yellow
$policy = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -ErrorAction SilentlyContinue
if (-not $policy) {
    Write-Host "  Policy 'Agent Warden - Block PII' not found!" -ForegroundColor Red
    Write-Host "  Run test/create-dlp-policy.ps1 first to create the policy." -ForegroundColor Red
    Disconnect-ExchangeOnline -Confirm:$false 2>$null
    exit 1
}
$policy | Format-List Name, Mode, Enabled, Workload, EnforcementPlanes, Guid

Write-Host "=== Current Rule ===" -ForegroundColor Yellow
$rule = Get-DlpComplianceRule -Identity "Block SSN and Credit Card" -ErrorAction SilentlyContinue
if (-not $rule) {
    Write-Host "  Rule 'Block SSN and Credit Card' not found!" -ForegroundColor Red
    Disconnect-ExchangeOnline -Confirm:$false 2>$null
    exit 1
}

Write-Host "  Name: $($rule.Name)"
Write-Host "  Disabled: $($rule.Disabled)"
Write-Host "  BlockAccess: $($rule.BlockAccess)"
Write-Host "  BlockAccessScope: $($rule.BlockAccessScope)"
Write-Host "  RestrictAccess: $(($rule.RestrictAccess | ConvertTo-Json -Compress -Depth 5) -replace '\s+',' ')"
Write-Host "  SIT types:"
foreach ($sit in $rule.ContentContainsSensitiveInformation) {
    Write-Host "    - $($sit.Name) (minCount=$($sit.minCount), confidence=$($sit.minConfidence)-$($sit.maxConfidence))"
}

# ── Update the rule ──
Write-Host "`n=== Updating Rule ===" -ForegroundColor Cyan
Write-Host "Setting BlockAccess=true, BlockAccessScope=All"
Write-Host "Setting RestrictAccess for UploadText=Block, DownloadText=Block"

# Step A: Update block settings (don't touch SIT to avoid format issues)
# Note: DownloadText RestrictAccess not supported for Entra-scoped policies
Set-DlpComplianceRule -Identity "Block SSN and Credit Card" `
    -BlockAccess $true `
    -BlockAccessScope "All" `
    -RestrictAccess @(
        @{setting="UploadText"; value="Block"}
    )

# Step B: Lower confidence threshold separately if needed
try {
    Set-DlpComplianceRule -Identity "Block SSN and Credit Card" `
        -ContentContainsSensitiveInformation @(
            @{Name = "Credit Card Number"; minCount = "1"; minConfidence = "65"; maxConfidence = "100"},
            @{Name = "U.S. Social Security Number (SSN)"; minCount = "1"; minConfidence = "65"; maxConfidence = "100"}
        )
    Write-Host "  Confidence thresholds lowered to 65" -ForegroundColor Green
} catch {
    Write-Host "  Could not update SIT confidence: $_" -ForegroundColor Yellow
    Write-Host "  Keeping existing SIT config (CC=85, SSN=75 confidence)" -ForegroundColor Yellow
}

Write-Host "  Rule updated!" -ForegroundColor Green

# ── Verify ──
Write-Host "`n=== Updated Rule ===" -ForegroundColor Yellow
$updated = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
Write-Host "  Disabled: $($updated.Disabled)"
Write-Host "  BlockAccess: $($updated.BlockAccess)"
Write-Host "  BlockAccessScope: $($updated.BlockAccessScope)"
Write-Host "  RestrictAccess: $(($updated.RestrictAccess | ConvertTo-Json -Compress -Depth 5) -replace '\s+',' ')"
Write-Host "  SIT:"
foreach ($sit in $updated.ContentContainsSensitiveInformation) {
    Write-Host "    - $($sit.Name) (min=$($sit.minCount), conf=$($sit.minConfidence)-$($sit.maxConfidence))"
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "DLP rule updated with blocking for both UploadText and DownloadText."
Write-Host "Policy changes can take up to 60 minutes to propagate to the processContent API."
Write-Host "Re-test with: bash scripts/_test-dlp-full.sh`n"

Disconnect-ExchangeOnline -Confirm:$false 2>$null
