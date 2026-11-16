// Investor challenge controls: questions go through the existing evidence-bound /api/ask handler.
// Never manufacture an answer, bypass access, or send credentials to a third party.
(() => {
  const prompts = [
    ["Defensibility", "What is defensible about this venture, and which evidence supports that claim?"],
    ["Technical risk", "Which technical risks are unresolved, and what has actually been tested?"],
    ["Business model", "What pricing, revenue, and cost assumptions are supported by founder statements?"],
    ["Competition", "What competitor evidence is available, and what remains unverified?"],
    ["Funding", "What is the stated funding ask, and which milestones does the evidence support?"],
    ["Diligence", "What evidence is missing before an investor could make a decision?"]
  ];
  function mount() {
    const qa = document.getElementById("qaBox");
    const ask = document.getElementById("askBtn");
    const q = document.getElementById("q");
    if (!qa || !ask || !q) return;
    const panel = document.createElement("div");
    panel.id = "investor-challenges";
    panel.setAttribute("aria-label", "Investor diligence questions");
    panel.innerHTML = '<h2>Investor challenge room</h2><p class="small mute">Choose a diligence challenge. Each response must use the current evidence pack; unsupported claims escalate to the founder.</p>';
    const row = document.createElement("div"); row.className = "row";
    for (const [label, question] of prompts) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "ghost"; button.textContent = label;
      button.addEventListener("click", () => { q.value = question; ask.click(); });
      row.append(button);
    }
    panel.append(row);
    qa.insertBefore(panel, qa.querySelector("#answers"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
