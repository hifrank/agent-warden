# Search for DLP-related audit events in the Purview E5 tenant
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Exchange Online (Purview E5 tenant)..."
Connect-ExchangeOnline

$startDate = (Get-Date).AddDays(-7).ToString("MM/dd/yyyy")
$endDate = (Get-Date).AddDays(1).ToString("MM/dd/yyyy")

Write-Output "`n=== Searching DLP Rule Match events (last 7 days) ==="
try {
    $dlpEvents = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -RecordType DlpRuleMatch -ResultSize 10
    if ($dlpEvents) {
        Write-Output "Found $($dlpEvents.Count) DLP rule match events:"
        foreach ($e in $dlpEvents) {
            Write-Output "  Date: $($e.CreationDate)  Op: $($e.Operations)  User: $($e.UserIds)"
        }
    } else {
        Write-Output "No DLP rule match events found."
    }
} catch {
    Write-Output "Error searching DLP events: $_"
}

Write-Output "`n=== Searching all DLP events ==="
try {
    $allDlp = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -Operations "DlpRuleMatch","DlpInfo","DLPEndpoint","DLPActionHits" -ResultSize 10
    if ($allDlp) {
        Write-Output "Found $($allDlp.Count) DLP events:"
        foreach ($e in $allDlp) {
            Write-Output "  Date: $($e.CreationDate)  Op: $($e.Operations)  User: $($e.UserIds)"
        }
    } else {
        Write-Output "No DLP events found via Operations search."
    }
} catch {
    Write-Output "Error: $_"
}

Write-Output "`n=== Searching for any processContent-related activity ==="
try {
    $appId = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa"
    $userId = "7ade9412-3a6e-4b37-a3a8-51d8f81de596"
    $userEvents = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -UserIds $userId -ResultSize 10
    if ($userEvents) {
        Write-Output "Found $($userEvents.Count) events for DLP user $userId :"
        foreach ($e in $userEvents) {
            Write-Output "  Date: $($e.CreationDate)  Op: $($e.Operations)  RecordType: $($e.RecordType)"
        }
    } else {
        Write-Output "No events found for DLP user ID $userId"
    }
} catch {
    Write-Output "Error: $_"
}

Write-Output "`n=== All recent audit events (sample) ==="
try {
    $recent = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -ResultSize 5
    if ($recent) {
        Write-Output "Found audit events (showing up to 5):"
        foreach ($e in $recent) {
            Write-Output "  Date: $($e.CreationDate)  Op: $($e.Operations)  RecordType: $($e.RecordType)"
        }
    } else {
        Write-Output "No audit events found at all in the last 7 days."
    }
} catch {
    Write-Output "Error: $_"
}
