// Best-effort GoFundMe campaign reader (mirrors the web app's lib). Unofficial;
// returns null if GoFundMe changes/blocks the public feed.
export type GoFundMeCampaign = { title?: string; image?: string; goal?: number; raised?: number };

function slugFrom(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (!/(^|\.)gofundme\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/f\/([a-z0-9][a-z0-9-]*)/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function fetchGoFundMe(url: string): Promise<GoFundMeCampaign | null> {
  const slug = slugFrom(url);
  if (!slug) return null;
  try {
    const res = await fetch(`https://gateway.gofundme.com/web-gateway/v1/feed/${slug}`, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; GoPumpMe/1.0)" },
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, any>;
    const c = (d.campaign || d) as Record<string, any>;
    const num = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);
    return {
      title: c.fund_name || c.title || undefined,
      image: c.media?.url || c.image_url || undefined,
      goal: num(c.goal_amount) ?? num(c.goalAmount),
      raised: num(c.current_amount) ?? num(c.balance?.amount) ?? num(c.currentAmount),
    };
  } catch {
    return null;
  }
}
