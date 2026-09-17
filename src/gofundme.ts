// Best-effort GoFundMe campaign reader (mirrors the web app's lib). GoFundMe has
// no API and the old gateway feed is dead (404); we read the public /f/<slug>
// page and parse the Fundraiser entity from its embedded __NEXT_DATA__ Apollo
// cache. Returns null if GoFundMe changes/blocks it.
export type GoFundMeCampaign = { title?: string; image?: string; goal?: number; raised?: number; donors?: number; currency?: string };

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

type State = Record<string, Record<string, any>>;
function ref(state: State, v: any): Record<string, any> | null {
  if (v && typeof v === "object") {
    if (v.__ref && state[v.__ref]) return state[v.__ref];
    return v;
  }
  return null;
}

export async function fetchGoFundMe(url: string): Promise<GoFundMeCampaign | null> {
  const slug = slugFrom(url);
  if (!slug) return null;
  try {
    const res = await fetch(`https://www.gofundme.com/f/${slug}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return null;
    const state: State | undefined = JSON.parse(m[1])?.props?.pageProps?.__APOLLO_STATE__;
    if (!state) return null;
    const key = Object.keys(state).find((k) => k.startsWith("Fundraiser:"));
    if (!key) return null;
    const f = state[key];
    const photo = ref(state, f.fundraiserPhoto);
    const cur = ref(state, f.currentAmount);
    const goal = ref(state, f.goalAmount);
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
    return {
      title: f.title || undefined,
      image: f.fundraiserImageUrl || photo?.scaled?.fourByThree1200 || photo?.scaled?.fourByThree600 || undefined,
      goal: num(goal?.amount),
      raised: num(cur?.amount),
      donors: num(f.donationCount),
      currency: cur?.currencyCode || undefined,
    };
  } catch {
    return null;
  }
}
