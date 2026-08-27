(function () {
  const config = window.JELLYBOT_CONFIG || { apiBase: "" };

  function apiUrl(path) {
    return `${config.apiBase.replace(/\/+$/, "")}${path}`;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function setStatus(el, message, kind) {
    el.textContent = message || "";
    el.classList.remove("error", "ok");
    if (kind) el.classList.add(kind);
  }

  async function fetchJson(path) {
    const response = await fetch(apiUrl(path), { credentials: "omit" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  }

  async function postJson(path, payload) {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  }

  function mountQuoteTry(root) {
    const queryInput = root.querySelector("#quote-query");
    const seriesInput = root.querySelector("#quote-series");
    const durationInput = root.querySelector("#quote-duration");
    const paddingInput = root.querySelector("#quote-padding");
    const suggestionsEl = root.querySelector("#quote-suggestions");
    const statusEl = root.querySelector("#quote-status");
    const previewEl = root.querySelector("#quote-preview");
    const renderBtn = root.querySelector("#quote-render");

    let selected = null;

    const loadSuggestions = debounce(async () => {
      selected = null;
      renderBtn.disabled = true;
      suggestionsEl.innerHTML = "";
      setStatus(statusEl, "Searching indexed subtitles…");

      const q = encodeURIComponent(queryInput.value.trim());
      const series = seriesInput.value.trim();
      const seriesParam = series ? `&series=${encodeURIComponent(series)}` : "";

      try {
        const body = await fetchJson(`/api/v1/quote/suggest?q=${q}${seriesParam}`);
        if (!body.suggestions.length) {
          setStatus(
            statusEl,
            body.minQueryLength > (queryInput.value.trim().length || 0)
              ? `Type at least ${body.minQueryLength} characters.`
              : "No matches yet. Try different words or add a series filter.",
          );
          return;
        }

        setStatus(statusEl, `${body.suggestions.length} matches`);
        for (const suggestion of body.suggestions) {
          const li = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = suggestion.label;
          button.addEventListener("click", () => {
            selected = suggestion;
            renderBtn.disabled = false;
            for (const node of suggestionsEl.querySelectorAll("button")) {
              node.setAttribute("aria-selected", node === button ? "true" : "false");
            }
            setStatus(statusEl, "Selected. Render preview when ready.", "ok");
          });
          li.appendChild(button);
          suggestionsEl.appendChild(li);
        }
      } catch (error) {
        setStatus(statusEl, error.message, "error");
      }
    }, 180);

    queryInput.addEventListener("input", loadSuggestions);
    seriesInput.addEventListener("input", loadSuggestions);

    renderBtn.addEventListener("click", async () => {
      if (!selected) return;
      renderBtn.disabled = true;
      previewEl.removeAttribute("src");
      setStatus(statusEl, "Rendering clip… this can take a few seconds.");

      try {
        const body = await postJson("/api/v1/quote/preview", {
          match: selected.token,
          duration: durationInput.value.trim() || undefined,
          padding: paddingInput.value.trim() || undefined,
          series: seriesInput.value.trim() || undefined,
        });
        previewEl.src = apiUrl(body.previewUrl);
        previewEl.load();
        setStatus(
          statusEl,
          `${body.label || "Preview ready."} URL: ${apiUrl(body.previewUrl)}`,
          "ok",
        );
      } catch (error) {
        setStatus(statusEl, error.message, "error");
      } finally {
        renderBtn.disabled = !selected;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const tryRoot = document.querySelector("[data-quote-try]");
    if (tryRoot) mountQuoteTry(tryRoot);

    const dmcaForm = document.getElementById("dmca-form");
    const dmcaStatus = document.getElementById("dmca-status");
    if (dmcaForm && dmcaStatus) {
      dmcaForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submitButton = dmcaForm.querySelector("button[type='submit']");
        if (submitButton) submitButton.disabled = true;
        setStatus(dmcaStatus, "Submitting report…");

        const payload = {
          kind: dmcaForm.kind.value,
          name: dmcaForm.name.value.trim(),
          email: dmcaForm.email.value.trim(),
          contactAddress: dmcaForm.contactAddress.value.trim(),
          contactPhone: dmcaForm.contactPhone.value.trim(),
          copyrightedWork: dmcaForm.copyrightedWork.value.trim(),
          infringingMaterial: dmcaForm.infringingMaterial.value.trim(),
          previewUrl: dmcaForm.previewUrl.value.trim(),
          details: dmcaForm.details.value.trim(),
          goodFaith: dmcaForm.goodFaith.checked,
          accuracy: dmcaForm.accuracy.checked,
          website: dmcaForm.website.value.trim(),
        };

        try {
          const response = await fetch(apiUrl("/api/v1/dmca/report"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            credentials: "omit",
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.ok) {
            throw new Error(body.error || `Request failed (${response.status})`);
          }
          dmcaForm.reset();
          setStatus(dmcaStatus, "Report submitted. We will review it.", "ok");
        } catch (error) {
          setStatus(dmcaStatus, error.message || "Submission failed.", "error");
        } finally {
          if (submitButton) submitButton.disabled = false;
        }
      });
    }
  });
})();
