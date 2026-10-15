(() => {
  const cfg = window.POLICE_RP_CONFIG || {};
  const configured = cfg.supabaseUrl && !cfg.supabaseUrl.includes("VOTRE-PROJET")
    && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes("VOTRE_CLE");
  const $ = (id) => document.getElementById(id);
  let supabaseClient = null;
  let currentAttempt = null;
  let questions = [];
  let answers = {};
  let currentIndex = 0;
  let deadline = null;
  let timerInterval = null;
  let hiddenSinceLastVisible = false;
  let visibilityEventPending = false;
  let localExitCount = 0;
  let eventQueue = [];

  function message(id, text, isError = true) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "var(--red)" : "#18794e";
  }

  function setAuthenticated(user) {
    $("auth-panel").classList.toggle("hidden", !!user);
    $("candidate-panel").classList.toggle("hidden", !user);
    if (user) { $("candidate-heading").textContent = "Votre espace de sélection"; loadMyResults(); }
  }

  async function callFunction(name, payload) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) throw new Error("Votre session a expiré. Reconnectez-vous.");
    const response = await fetch(`${cfg.functionsBaseUrl}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
        "apikey": cfg.supabaseAnonKey
      },
      body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "La requête n'a pas abouti.");
    return data;
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!configured || !supabaseClient) {
      message("auth-message", "Le site n'est pas encore configuré. Renseignez les paramètres Supabase dans config.js.");
      return;
    }
    message("auth-message", "Connexion en cours…", false);
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value
    });
    if (error) return message("auth-message", "Connexion impossible. Vérifiez vos identifiants.");
    message("auth-message", "", false);
  });

  $("logout-button").addEventListener("click", async () => {
    if (currentAttempt) {
      message("exam-message", "Terminez l'examen avant de vous déconnecter.");
      return;
    }
    await supabaseClient.auth.signOut();
  });

  $("start-button").addEventListener("click", async () => {
    const code = $("exam-code").value.trim();
    if (!code) return message("start-message", "Saisissez le code communiqué par le recruteur.");
    $("start-button").disabled = true;
    try {
      const result = await callFunction("quick-action", { examCode: code });
      currentAttempt = result.attempt;
      questions = result.questions;
      answers = {};
      currentIndex = 0;
      localExitCount = 0;
      eventQueue = [];
      deadline = new Date(result.attempt.deadline_at).getTime();
      $("candidate-home").classList.add("hidden");
      $("exam-view").classList.remove("hidden");
      renderQuestion();
      startTimer();
      message("exam-message", result.resumed ? "Tentative reprise : vos réponses précédentes n'ont pas été conservées, le chronomètre n'a pas été interrompu." : "Examen démarré. Le chronomètre continue si vous quittez la page.", false);
    } catch (error) {
      message("start-message", error.message || "Impossible de démarrer l'examen.");
    } finally {
      $("start-button").disabled = false;
    }
  });

  function renderQuestion() {
    const q = questions[currentIndex];
    if (!q) return;
    $("progress").textContent = `${currentIndex + 1} / ${questions.length}`;
    $("progress-bar").style.width = `${((currentIndex + 1) / questions.length) * 100}%`;
    const container = $("question-container");
    container.replaceChildren();
    const kicker = document.createElement("p");
    kicker.className = "question-kicker";
    kicker.textContent = `QUESTION ${String(currentIndex + 1).padStart(2, "0")}`;
    const title = document.createElement("h3");
    title.className = "question-title";
    title.textContent = q.prompt;
    container.append(kicker, title);
    q.options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "answer";
      radio.value = option.id;
      radio.checked = answers[q.id] === option.id;
      radio.addEventListener("change", () => { answers[q.id] = option.id; });
      const text = document.createElement("span");
      text.textContent = option.text;
      label.append(radio, text);
      container.append(label);
    });
    $("previous-button").disabled = currentIndex === 0;
    $("next-button").textContent = currentIndex === questions.length - 1 ? "Terminer l'examen" : "Suivante";
  }

  $("previous-button").addEventListener("click", () => {
    if (currentIndex > 0) { currentIndex--; renderQuestion(); }
  });

  $("next-button").addEventListener("click", async () => {
    if (currentIndex < questions.length - 1) {
      currentIndex++;
      renderQuestion();
      return;
    }
    const unanswered = questions.filter(q => !answers[q.id]).length;
    const confirmed = unanswered === 0 || window.confirm(`Il reste ${unanswered} question(s) sans réponse. Transmettre quand même ?`);
    if (!confirmed) return;
    $("next-button").disabled = true;
    try {
      try { await flushEvents(); } catch (_) { /* les événements restants partent avec la soumission */ }
      const result = await callFunction("super-service", {
        attemptId: currentAttempt.id,
        answers: Object.entries(answers).map(([questionId, optionId]) => ({ questionId, optionId })),
        events: eventQueue
      });
      stopTimer();
      currentAttempt = null;
      $("exam-view").classList.add("hidden");
      $("exam-finished").classList.remove("hidden");
      $("finish-summary").textContent = `Examen transmis · Réponses traitées : ${result.answeredCount}/${questions.length}.`;
    } catch (error) {
      message("exam-message", error.message || "La transmission a échoué. Vérifiez votre connexion et réessayez.");
    } finally {
      $("next-button").disabled = false;
    }
  });

  function startTimer() {
    stopTimer();
    updateTimer();
    timerInterval = window.setInterval(updateTimer, 1000);
  }
  function stopTimer() {
    if (timerInterval) window.clearInterval(timerInterval);
    timerInterval = null;
  }
  function updateTimer() {
    const seconds = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    $("timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    if (seconds <= 0) {
      stopTimer();
      message("exam-message", "Temps écoulé. Transmettez vos réponses immédiatement.");
      $("next-button").textContent = "Transmettre les réponses";
    }
  }

  async function flushEvents() {
    if (!currentAttempt || !eventQueue.length) return;
    const batch = eventQueue.slice();
    await callFunction("super-service", { attemptId: currentAttempt.id, events: batch, eventsOnly: true });
    eventQueue = eventQueue.slice(batch.length);
  }

  document.addEventListener("visibilitychange", () => {
    if (!currentAttempt) return;
    if (document.visibilityState === "hidden") {
      if (!hiddenSinceLastVisible) {
        hiddenSinceLastVisible = true;
        localExitCount++;
        eventQueue.push({ type: "page_hidden", occurredAt: new Date().toISOString(), sequence: localExitCount });
        message("exam-message", `Attention : sortie de page détectée (${localExitCount}). À partir de 3 sorties, votre session sera signalée.`);
      }
    } else if (hiddenSinceLastVisible) {
      hiddenSinceLastVisible = false;
      eventQueue.push({ type: "page_visible", occurredAt: new Date().toISOString(), sequence: localExitCount });
      if (localExitCount >= 3) message("exam-message", "Votre session sera signalée au recruteur pour vérification.");
      // Best effort only: a network interruption may prevent immediate event delivery.
      flushEvents().catch(() => {});
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (currentAttempt) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  function statusOf(r) {
    if (r.status === "in_progress") return { text: "En cours", cls: "" };
    if (r.unlocked) return { text: "Nouvelle tentative autorisée", cls: "" };
    if (r.review_status === "pending") return { text: "En attente de vérification par un recruteur", cls: "warn" };
    if (r.review_status === "refused") return { text: "Refusé — nouvelle tentative uniquement sur autorisation d'un recruteur", cls: "bad" };
    return r.passed ? { text: "Réussi", cls: "ok" }
      : { text: "Échoué — nouvelle tentative uniquement sur autorisation d'un recruteur", cls: "bad" };
  }
  async function loadMyResults() {
    const box = $("my-results");
    if (!box || !supabaseClient) return;
    const { data, error } = await supabaseClient.rpc("my_results");
    if (error) { box.textContent = ""; return; }
    const latest = new Map();
    (data || []).forEach((r) => { if (!latest.has(r.exam_id)) latest.set(r.exam_id, r); });
    box.replaceChildren();
    if (!latest.size) { box.textContent = "Aucun examen passé pour le moment."; return; }
    latest.forEach((r) => {
      const row = document.createElement("div");
      row.className = "result-row";
      const name = document.createElement("strong");
      name.textContent = r.exam_title;
      const s = statusOf(r);
      const tag = document.createElement("span");
      tag.className = `tag ${s.cls}`;
      tag.textContent = s.text;
      row.append(name, tag);
      box.append(row);
    });
  }
  $("back-home").addEventListener("click", () => {
    $("exam-finished").classList.add("hidden");
    $("candidate-home").classList.remove("hidden");
    $("exam-code").value = "";
    message("start-message", "", false);
    loadMyResults();
  });

  async function init() {
    if (!configured || !window.supabase) {
      $("auth-message").textContent = "Configuration requise : renseignez config.js puis déployez les fonctions Supabase.";
      return;
    }
    supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data: { session } } = await supabaseClient.auth.getSession();
    setAuthenticated(session?.user || null);
    supabaseClient.auth.onAuthStateChange((_event, nextSession) => setAuthenticated(nextSession?.user || null));
  }
  init();
})();