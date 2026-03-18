# Activate audit via Security & Compliance PowerShell (different from Exchange Online)
Import-Module ExchangeOnlineManagement

Write-Output "Step 1: Connect to Security & Compliance PowerShell..."
Connect-IPPSSession

Write-Output "`nStep 2: Enable Organization Customization..."
try {
    Enable-OrganizationCustomization -ErrorAction Stop
    Write-Output "Organization customization ENABLED."
} catch {
    Write-Output "Organization customization status: $_"
}

Write-Output "`nStep 3: Check audit via S&C cmdlet..."
try {
    $auditStatus = Get-AdminAuditLogConfig
    Write-Output "UnifiedAuditLogIngestionEnabled: $($auditStatus.UnifiedAuditLogIngestionEnabled)"
} catch {
    Write-Output "Could not check: $_"
}

Write-Output "`nStep 4: Enable via S&C PowerShell..."
try {
    Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true -ErrorAction Stop
    Write-Output "Enabled via S&C!"
} catch {
    Write-Output "S&C enable result: $_"
}

Write-Output "`nStep 5: Now connecting to Exchange Online for cross-check..."
Connect-ExchangeOnline

Write-Output "`nStep 6: Verify via Exchange Online..."
$exoAudit = Get-AdminAuditLogConfig
Write-Output "UnifiedAuditLogIngestionEnabled: $($exoAudit.UnifiedAuditLogIngestionEnabled)"

Write-Output "`nStep 7: Test Search..."
$start = (Get-Date).AddDays(-1).ToString("MM/dd/yyyy")
$end = (Get-Date).AddDays(1).ToString("MM/dd/yyyy")
try {
    $test = Search-UnifiedAuditLog -StartDate $start -EndDate $end -ResultSize 1
    if ($test) {
        Write-Output "Audit search WORKS! Found events."
    } else {
        Write-Output "Audit search returned empty — infrastructure may need 24-48h to provision."
    }
} catch {
    Write-Output "Audit search error: $_"
}

Write-Output "`n=== Summary ==="
Write-Output "If audit search still fails, the tenant audit infrastructure needs time to provision."
Write-Output "Go to https://purview.microsoft.com > DSPM for AI > Overview > Activate Microsoft Purview Audit"
Write-Output "Then wait 24-48 hours for full activation."
