package expo.modules.kiosk

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

// The other half of the setup hotspot: once an installer's phone has joined the
// totem's own network, this is what it talks to. The page is served by the
// television itself, so none of it needs internet, and the venue password is
// typed on a phone keyboard instead of a remote.
class SetupServer(
  port: Int,
  private val deviceId: String?,
  private val scan: () -> List<Map<String, Any?>>,
  private val connect: (String, String?) -> Boolean,
  private val currentNetwork: () -> String?,
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response = when {
    session.uri == "/api/networks" -> json(networksPayload())
    session.uri == "/api/status" -> json(statusPayload())
    session.uri == "/api/connect" && session.method == Method.POST -> handleConnect(session)
    else -> newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", page())
  }

  private fun json(body: JSONObject): Response =
    newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", body.toString())

  private fun networksPayload(): JSONObject {
    val networks = JSONArray()

    runCatching { scan() }.getOrDefault(emptyList()).forEach { network ->
      networks.put(
        JSONObject()
          .put("ssid", network["ssid"])
          .put("level", network["level"])
          .put("secured", network["secured"])
      )
    }

    return JSONObject().put("networks", networks)
  }

  private fun statusPayload(): JSONObject = JSONObject()
    .put("network", currentNetwork())
    .put("deviceId", deviceId)

  private fun handleConnect(session: IHTTPSession): Response {
    val body = HashMap<String, String>()

    return try {
      session.parseBody(body)
      val payload = JSONObject(body["postData"] ?: "{}")
      val ssid = payload.optString("ssid")
      val password = payload.optString("password").ifBlank { null }

      if (ssid.isBlank()) {
        return json(JSONObject().put("ok", false).put("error", "Falta la red"))
      }

      val accepted = connect(ssid, password)
      json(JSONObject().put("ok", accepted))
    } catch (error: Throwable) {
      json(JSONObject().put("ok", false).put("error", error.message ?: "Error"))
    }
  }

  private fun page(): String = """
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configurar tótem</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px 20px 48px;
    background: #24191C; color: #F6ECE1;
    font: 17px/1.5 system-ui, -apple-system, sans-serif;
  }
  h1 { font-size: 26px; margin: 0 0 4px; }
  p.sub { color: #C4A99B; margin: 0 0 24px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li button {
    width: 100%; text-align: left; display: flex; gap: 12px; align-items: center;
    background: #170F11; color: inherit; border: 0; border-radius: 12px;
    padding: 16px; margin-bottom: 10px; font: inherit; cursor: pointer;
  }
  li button[aria-pressed="true"] { background: #F2B441; color: #24191C; }
  .bars { color: #F2B441; letter-spacing: 2px; }
  li button[aria-pressed="true"] .bars { color: #24191C; }
  label { display: block; margin: 20px 0 8px; color: #C4A99B; }
  input, .cta {
    width: 100%; box-sizing: border-box; border-radius: 12px; font: inherit;
    padding: 16px; border: 2px solid #4A3A3E; background: #170F11; color: inherit;
  }
  .cta { background: #F2B441; color: #24191C; border: 0; font-weight: 700; margin-top: 16px; }
  .cta[disabled] { opacity: .5; }
  .msg { margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: #170F11; }
  .msg.bad { color: #E8705A; }
  .msg.good { color: #F2B441; }
  footer { margin-top: 32px; color: #8D7670; font-size: 14px; }
</style>
</head>
<body>
  <h1>Configurar tótem</h1>
  <p class="sub">Equipo <strong id="device">…</strong> · Red actual: <strong id="current">…</strong></p>

  <ul id="networks"><li>Buscando redes…</li></ul>

  <form id="form" hidden>
    <label for="password">Clave de <span id="chosen"></span></label>
    <input id="password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="cta" id="submit" type="submit">Conectar</button>
  </form>

  <div id="message" class="msg" hidden></div>
  <footer>Esta página la sirve el propio tótem. No necesita internet.</footer>

<script>
  let chosen = null;

  const show = (text, ok) => {
    const box = document.getElementById('message');
    box.textContent = text;
    box.className = 'msg ' + (ok ? 'good' : 'bad');
    box.hidden = false;
  };

  async function refreshStatus() {
    const status = await fetch('/api/status').then((r) => r.json());
    document.getElementById('device').textContent = status.deviceId || '—';
    document.getElementById('current').textContent = status.network || 'sin conexión';
  }

  async function loadNetworks() {
    const { networks } = await fetch('/api/networks').then((r) => r.json());
    const list = document.getElementById('networks');
    list.innerHTML = '';

    if (!networks.length) {
      list.innerHTML = '<li>No se encontró ninguna red.</li>';
      return;
    }

    networks.forEach((network) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML =
        '<span class="bars">' + '▮'.repeat(Math.max(network.level, 1)) + '</span>' +
        '<span>' + network.ssid + (network.secured ? ' 🔒' : '') + '</span>';
      button.onclick = () => {
        chosen = network;
        document.querySelectorAll('#networks button').forEach((other) =>
          other.setAttribute('aria-pressed', 'false'));
        button.setAttribute('aria-pressed', 'true');
        document.getElementById('chosen').textContent = network.ssid;
        document.getElementById('form').hidden = false;
        document.getElementById('password').focus();
      };
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  document.getElementById('form').onsubmit = async (event) => {
    event.preventDefault();
    if (!chosen) return;

    const submit = document.getElementById('submit');
    submit.disabled = true;
    show('Conectando a ' + chosen.ssid + '…', true);

    try {
      await fetch('/api/connect', {
        method: 'POST',
        body: JSON.stringify({
          ssid: chosen.ssid,
          password: document.getElementById('password').value,
        }),
      });
    } catch (error) {
      // Joining the venue network can drop this page's own connection, which
      // is expected: the result is read back from the totem instead.
    }

    setTimeout(async () => {
      try {
        const status = await fetch('/api/status').then((r) => r.json());
        show(
          status.network === chosen.ssid
            ? 'Listo, el tótem quedó conectado a ' + status.network + '.'
            : 'No se pudo conectar. Revisa la clave e intenta de nuevo.',
          status.network === chosen.ssid,
        );
        refreshStatus();
      } catch (error) {
        show('El tótem cambió de red. Mira la pantalla para confirmar.', true);
      }
      submit.disabled = false;
    }, 8000);
  };

  refreshStatus();
  loadNetworks();
</script>
</body>
</html>
  """.trimIndent()
}
