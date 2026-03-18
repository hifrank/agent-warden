# Diagnose audit provisioning issue on E5 tenant
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Exchange Online (Purview E5 tenant 2cf24558)..."
Connect-ExchangeOnline

Write-Output "`n=== Organization Config ==="
$org = Get-OrganizationConfig
Write-Output "Name: $($org.Name)"
Write-Output "IsDehydrated: $($org.IsDehydrated)"
Write-Output "ReleaseTrack: $($org.ReleaseTrack)"

Write-Output "`n=== Mailboxes ==="
$mailboxes = Get-EXOMailbox -ResultSize 10
if ($mailboxes) {
    Write-Output "Found $($mailboxes.Count) mailbox(es):"
    foreach ($mb in $mailboxes) {
        Write-Output "  $($mb.UserPrincipalName) — Type: $($mb.RecipientTypeDetails)"
    }
} else {
    Write-Output "NO MAILBOXES FOUND — this is likely the root cause!"
    Write-Output "Audit requires at least one licensed Exchange Online mailbox."
}

Write-Output "`n=== DLP User Mailbox Check ==="
$dlpUserId = "7ade9412-3a6e-4b37-a3a8-51d8f81de596"
try {
    $dlpMb = Get-EXOMailbox -Identity $dlpUserId -ErrorAction Stop
    Write-Output "DLP user mailbox: $($dlpMb.UserPrincipalName) — Type: $($dlpMb.RecipientTypeDetails)"
} catch {
    Write-Output "DLP user ($dlpUserId) has NO mailbox: $_"
}

Write-Output "`n=== Admin Audit Config (full) ==="
$auditCfg = Get-AdminAuditLogConfig
Write-Output "UnifiedAuditLogIngestionEnabled: $($auditCfg.UnifiedAuditLogIngestionEnabled)"
Write-Output "UnifiedAuditLogFirstOptInDate: $($auditCfg.UnifiedAuditLogFirstOptInDate)"
Write-Output "UnifiedAuditLogDataProvisioned: $($auditCfg.UnifiedAuditLogDataProvisioned)"

Write-Output "`n=== Enable-OrganizationCustomization ==="
try {
    Enable-OrganizationCustomization -ErrorAction Stop
    Write-Output "Organization customization ENABLED successfully!"
} catch {
    $errMsg = $_.Exception.Message
    if ($errMsg -match "already been enabled") {
        Write-Output "Organization customization already enabled."
    } else {
        Write-Output "Result: $errMsg"
    }
}

Write-Output "`n=== Retry: Set-AdminAuditLogConfig ==="
try {
    Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true -ErrorAction Stop
    Write-Output "Set UnifiedAuditLogIngestionEnabled = True"
} catch {
    Write-Output "Error: $_"
}

Write-Output "`n=== Final Verify ==="
$finalCfg = Get-AdminAuditLogConfig
Write-Output "UnifiedAuditLogIngestionEnabled: $($finalCfg.UnifiedAuditLogIngestionEnabled)"
Write-Output "UnifiedAuditLogFirstOptInDate: $($finalCfg.UnifiedAuditLogFirstOptInDate)"
