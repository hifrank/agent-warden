<script lang="ts">
  import "../app.css";
  import { browser } from "$app/environment";
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import { acquireApiToken, ensureSignedIn } from "$lib/auth/msal.js";

  let { children } = $props();
  let authStatus = $state<"idle" | "authenticating" | "ready" | "disabled">("idle");

  onMount(async () => {
    if (!browser) return;

    const hasAuthConfig = !!(env.PUBLIC_ENTRA_CLIENT_ID && env.PUBLIC_ENTRA_TENANT_ID);
    if (!hasAuthConfig) {
      authStatus = "disabled";
      return;
    }

    authStatus = "authenticating";
    try {
      await ensureSignedIn();

      // Tell the server that MSAL auth succeeded so SSR loaders return real data.
      // Use SameSite=Lax so the cookie survives the cross-site redirect from Microsoft login.
      const hadCookie = document.cookie.includes("aw-session=");
      document.cookie = "aw-session=1;path=/;secure;samesite=lax;max-age=86400";

      // If this is the first sign-in (page was served without data), reload to get SSR data
      if (!hadCookie) {
        location.reload();
        return;
      }

      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!reqUrl.startsWith("/api/")) {
          return nativeFetch(input as RequestInfo, init);
        }

        const token = await acquireApiToken();
        const headers = new Headers(init?.headers ?? {});
        headers.set("Authorization", `Bearer ${token}`);

        return nativeFetch(input as RequestInfo, {
          ...init,
          headers,
        });
      };

      authStatus = "ready";
    } catch (err) {
      console.error("[portal] MSAL sign-in failed", err);
      authStatus = "disabled";
    }
  });
</script>

<div class="shell">
  <header class="topbar">
    <div class="logo">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
      <span>Agent Warden</span>
    </div>
    <nav class="topnav">
      <a href="/" class="nav-link">Instances</a>
      <a href="/skills" class="nav-link">Skill Management</a>
      <a href="/mcp" class="nav-link">MCP Management</a>
      <a href="/settings" class="nav-link">Settings</a>
    </nav>
  </header>

  <main class="content">
    {#if authStatus === "authenticating"}
      <div class="auth-banner">Signing in with Microsoft Entra...</div>
    {/if}
    {@render children()}
  </main>
</div>

<style>
  .shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 2rem;
    padding: 0 1.5rem;
    height: 56px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    box-shadow: var(--shadow);
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .topnav {
    display: flex;
    gap: 0.25rem;
  }

  .nav-link {
    padding: 0.5rem 1rem;
    border-radius: var(--radius);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-muted);
    transition: all 0.15s;
  }

  .nav-link:hover {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .content {
    flex: 1;
    padding: 1.5rem;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
  }

  .auth-banner {
    margin-bottom: 1rem;
    padding: 0.65rem 0.9rem;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    border-radius: var(--radius);
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }
</style>
