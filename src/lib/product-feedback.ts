type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Feedback = { text: string; rating?: "up" | "down"; consent: boolean };
type ShareTarget = { share?: (data: ShareData) => Promise<void>; clipboard: { writeText: (text: string) => Promise<void> } };

export async function sendProductFeedback(feedback: Feedback, request: Request): Promise<void> {
  if (!feedback.consent) throw new Error("Choose to share this feedback first.");
  const text = feedback.text.trim();
  if (!text && !feedback.rating) throw new Error("Write a note before sending.");
  await request("/api/product/feedback", { method: "POST", body: JSON.stringify({ text, ...(feedback.rating ? { rating: feedback.rating } : {}) }) });
}

export async function confirmUsefulResult(confirmed: boolean, request: Request): Promise<void> {
  if (!confirmed) throw new Error("Confirm that BOS completed a useful task first.");
  await request("/api/product/job-done", { method: "POST", body: JSON.stringify({ confirmed: true }) });
}

export async function shareReferral(url: string, target: ShareTarget): Promise<"shared" | "copied"> {
  if (typeof target.share === "function") {
    await target.share({ title: "Try BOS", url });
    return "shared";
  }
  await target.clipboard.writeText(url);
  return "copied";
}
