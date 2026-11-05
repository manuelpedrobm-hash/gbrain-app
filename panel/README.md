# Cerebro: el panel local de GBrain

Una página en `http://127.0.0.1:3140` con ocho pestañas (Hoy · Pendientes · Diario · Mensajes · Memoria · Chat · Estrategia · Asistente), una franja de salud arriba y búsqueda con ⌘K. Funciona solo en este Mac: nada escucha fuera de `127.0.0.1`.

## Abrir el panel

Doble clic en **«Abrir panel.command»** (en esta carpeta). Pide al panel un código de un solo uso y abre el navegador ya con la sesión iniciada. Si sale «El panel no está en marcha», arráncalo (abajo).

La sesión dura 30 días. Si abres `http://127.0.0.1:3140` sin sesión verás «Abre el panel con «Abrir panel»». «Cerrar sesión» (en Estado) la anula también en el servidor: esa cookie deja de valer aunque alguien la hubiera copiado.

## Arrancar, parar y reiniciar

El panel corre como servicio de launchd (`com.__USER__.gbrain-panel`). La plantilla está en `launchd/`.

**Instalar (una sola vez):**

```zsh
cp __REPO__/panel/launchd/com.__USER__.gbrain-panel.plist ~/Library/LaunchAgents/
chmod 644 ~/Library/LaunchAgents/com.__USER__.gbrain-panel.plist
launchctl bootstrap gui/__UID__ ~/Library/LaunchAgents/com.__USER__.gbrain-panel.plist
```

**Reiniciar** (por ejemplo tras actualizar gbrain o claude):

```zsh
launchctl kickstart -k gui/__UID__/com.__USER__.gbrain-panel
```

**Parar del todo:**

```zsh
launchctl bootout gui/__UID__/com.__USER__.gbrain-panel
```

**Probar a mano sin launchd** (se para con Ctrl-C):

```zsh
/opt/homebrew/bin/bun run __REPO__/panel/server.ts
```

El registro está en `~/Library/Logs/gbrain-panel.log`. Solo contiene método, ruta, estado y milisegundos (nunca contenido, códigos ni secretos).

## Comprobar que todo está bien

```zsh
bun __REPO__/panel/check.ts     # dependencias reales (solo lectura, no gasta nada)
cd __REPO__/panel && bun test   # pruebas con datos de ejemplo
```

Ejecuta `check.ts` después de cada actualización de gbrain o de claude. Cada línea dice PASS, WARN o FAIL.

## Qué hace y qué no hace

- **Lee** la base de datos de GBrain con una conexión de **solo lectura**. Al arrancar lo comprueba (intenta crear una tabla temporal y tiene que fallar); si la conexión permitiera escribir, el panel no arranca.
- **Escribe** solo a través de `gbrain call`, con una lista cerrada de herramientas: guardar, olvidar y corregir hechos (`remember`, `forget`), apuntar notas (`capture`), y la lista de tareas `ops/tasks` (`get_page` + `edit_page`; `put_page` solo para crearla la primera vez). Cada escritura queda anotada en `~/.gbrain-panel/audit.jsonl` (qué, cuándo, si salió bien; sin el contenido).
- **Tareas:** viven en la página del cerebro `ops/tasks`, con el formato de la skill daily-task-manager (secciones en inglés: `## P0 — Urgent`, `## P1 — Today`…). Si otra sesión cambia la lista a la vez, el panel reintenta una vez; si vuelve a chocar, dice «Otra sesión cambió las tareas; recarga». El «Mapa de misiones» está en la pestaña Misiones (abajo).
- **Chat:** cada mensaje lanza `claude -p` con Sonnet por defecto, sin herramientas de archivos ni de red, solo con el cerebro (`mcp__cerebro__*`). Límites: 2 US$ por conversación y 5 US$ al día; Opus pide confirmación. Los costes que muestra el panel son **estimaciones**; la factura real está en la Console.
- **El chat solo lee.** No puede editar páginas ni tareas. Si le pides guardar un hecho o apuntar una nota, lo **propone**: sale una tarjeta con «Revisar y guardar», que abre el formulario de siempre ya relleno, y no se guarda nada hasta que pulsas Guardar. Así, un texto malicioso que el asistente lea en el cerebro (un correo importado, por ejemplo) no puede escribir nada por su cuenta. Los enlaces externos de sus respuestas salen como texto, sin clic.
- **Nunca:** edita otras páginas, borra nada, toca la configuración de gbrain o de Claude, ni responde por Telegram.
- **Nunca arregla solo** los problemas de la pestaña Estado: los explica y dice cómo arreglarlos.

## Diario

Un cuaderno de apuntes por días. Lee los archivos `AAAA-MM-DD.md` de la carpeta `~/Documents/DIARIO` (o, si el panel no puede leerla, la copia del cerebro en `sources/informes-claude/DIARIO`), del más reciente al más antiguo. «Apuntar» **añade** una línea con la hora al diario de hoy, bajo «## Apuntes desde el panel»; nunca reescribe lo que hay. Si macOS no deja al panel escribir en esa carpeta, lo dice y explica cómo darle permiso.

Las tareas, los compromisos y las fechas viven en **Pendientes** y **Hoy** (página `ops/tasks`, hechos de tipo compromiso y tabla de fechas): el Diario es solo para anotar lo que pasa.

## Estrategia

La pestaña **Estrategia** enseña la página del cerebro `ops/estrategia`, **solo lectura**: arriba los tres frentes propuestos con el estado de la decisión («Pendiente de __NOMBRE__» mientras la página diga que no está decidida), después la hoja de ruta con insignias de color (Hecho en verde, En curso en azul, Necesita tu sí en ámbar, Idea en gris; se pueden filtrar), las decisiones abiertas y la página completa. Las tablas las lee el servidor; si una no se deja leer, se muestra el texto tal cual.

**«Proponer cambio»** no edita la página: abre el formulario «Recordar» ya relleno (sobre `ops/estrategia`) y, al pulsar Guardar, guarda un hecho con `remember`, por la misma lista cerrada de escrituras y con su línea en `audit.jsonl`. Para cambiar la propia página de estrategia, díselo a Claude.

## Asistente

La pestaña **Asistente** rellena formularios web en tu navegador (Dia, con la extensión Claude in Chrome) con los datos de la página del cerebro `notes/datos-formularios`, y **no envía nada sin tu Aprobar**. Le escribes la tarea («rellena la solicitud X en esta web con los datos de __ORG__») y, opcionalmente, la dirección; el panel enseña un resumen (web, formulario, cada campo con su valor y de dónde sale, lo que falta, avisos y el botón que se pulsaría) con **Aprobar y enviar** y **Rechazar**.

Cómo se fuerza la aprobación (con tecnología, no solo con instrucciones):

1. **Fase 1, preparar.** El servidor lanza `claude -p --chrome` con sus propios ajustes (`agente-asistente/settings.json`, `CLAUDE.md` propio, `--strict-mcp-config`, `dontAsk`). Solo existen `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `read_page`, `get_page_text`, `find` y `form_input` (más `select_browser` limitado al navegador que fijes y el cerebro en solo lectura). **No existe `computer`**: sin él el agente puede escribir en un campo, pero no pulsar Enviar, ni teclear Enter, ni hacer clic. Tampoco `javascript_tool`, subida de archivos ni GIF. Todo pasa por el filtro `ops/chrome-dominios.py` (falla cerrado). Otro filtro (`agente-asistente/hook-fase1.py`) impide abrir URLs con parámetros de consulta (`?x=…`) que no sean exactamente las que tú diste. Acaba con un bloque JSON que el servidor valida con esquema estricto (sin claves de más, url de un dominio aprobado, límites de tamaño, y `boton_ref`: la referencia exacta del botón de envío); los textos de la web pierden saltos de línea, caracteres de control y delimitadores; la interfaz lo pinta como texto, nunca como HTML.
2. **Fase 2, enviar**, solo si pulsas Aprobar (POST con cookie, Origin/Host/CSRF como el resto, y línea en `audit.jsonl`). Aprobar vale para **esa** propuesta: id único, un solo uso, caduca a los 15 min y va ligado a un hash de web + campos + botón (texto y referencia). El servidor **reanuda la misma sesión de claude** (las pestañas de la extensión pertenecen a la sesión: una sesión nueva no vería la pestaña rellenada) con `settings-fase2.json`: sin `navigate` ni `form_input`, y `computer` limitado por `hook-fase2.py` a **un único clic cuya referencia sea exactamente la del botón aprobado** (el servidor se la da al hook por un archivo de aprobación, no por el prompt), sin teclear. El prompt de la fase 2 no lleva ningún texto de la web, solo el id, esa referencia y la huella. Que el clic ocurrió lo sabe el panel por el archivo que crea ese hook, no por lo que cuente el agente. Antes del clic el agente comprueba que la pestaña es la misma web y que los valores que él mismo rellenó siguen ahí; si no, no hace clic (esa comprobación sí depende del agente; qué se pulsa, cuántas veces y que no se teclea ni se navega, no). Límite residual: la fase 2 reanuda la sesión de la fase 1, cuyo contexto incluye lo que leyó de la web; por eso solo puede pulsar un botón fijado de antemano, una vez. Detalle en `SPEC.md` §15, junto con lo que el filtro de la fase 1 no cubre (rutas sin parámetros en dominios aprobados, formularios que se envían solos al cambiar un campo).
3. Nunca pagos, contraseñas, códigos de verificación, identificadores personales ni subir archivos: si la web los pide, la fase se detiene y el panel te lo avisa para que lo hagas tú.

Además: una sola ejecución a la vez; tiempo máximo de 5 min (fase 1) y 2 min (fase 2); **Cancelar** mata el proceso y una sesión mínima cierra la pestaña (igual que Rechazar y la caducidad); estado en vivo con los pasos (qué herramienta, sin valores); lista de dominios aprobados en solo lectura (se cambia fuera del panel, con tu sí, en `~/.gbrain-coach/formularios-dominios.json` / `notes/formularios-dominios`); **tras un envío la pestaña se queda abierta** para que veas la confirmación de la web, con un botón **Cerrar pestaña** en la tarjeta de la ejecución; **todo intento** contra `/api/asistente/*`, aceptado o rechazado (también los 401/403 de la guardia y los 404/409/410 de Aprobar, Rechazar o Cancelar), deja una línea en `audit.jsonl` con motivo, id de propuesta e IP local, nunca valores ni secretos; y cada formulario se anota en `notes/formularios-registro` (fecha, web sin parámetros, formulario, **etiquetas** de los campos, nunca valores, aprobado/enviado) con una única `edit_page` sobre esa página.

Ajustes privados en `~/.gbrain-panel/asistente.json` (la API nunca los toca): `navegadorId` (deviceId del navegador, necesario cuando la extensión tiene más de un navegador conectado, por ejemplo Dia y otro) y `datosFile` (ruta de un archivo de datos **ficticios** para pruebas; mientras exista, la pestaña lo dice y no se usa el cerebro). **Facturación:** el asistente siempre usa tu sesión de claude.ai, nunca la clave de API de Ajustes: con clave de API, `claude` lanzado desde el panel no ve la integración con el navegador (comprobado). Si no la ve, el panel lo dice y no toca ninguna web. Con la extensión conectada a varios navegadores, fija `navegadorId`. Pruebas: `bun test test/asistente.test.ts` (con un `claude` falso).

## Dónde están las cosas

| Qué | Dónde |
|---|---|
| Código | `__REPO__/panel/` |
| Configuración (sin secretos) | `config.json` |
| Estado del panel | `~/.gbrain-panel/` (carpeta privada, 0700) |
| Secreto de sesión | `~/.gbrain-panel/secret` (0600) |
| Sesiones abiertas (solo su huella HMAC, no la cookie) | `~/.gbrain-panel/sessions.json` (0600) |
| Última visita, slug de tareas | `~/.gbrain-panel/state.json` |
| Conversaciones del chat | `~/.gbrain-panel/chats/` |
| Gasto del chat | `~/.gbrain-panel/spend.jsonl` |
| Escrituras hechas desde el panel | `~/.gbrain-panel/audit.jsonl` |

## Problemas frecuentes

- **«El panel no está en marcha»**: `launchctl kickstart -k gui/__UID__/com.__USER__.gbrain-panel`. Si sigue sin arrancar, mira las últimas líneas de `~/Library/Logs/gbrain-panel.log`.
- **«autocomprobación fallida» en el registro**: la conexión a Postgres no es de solo lectura o Postgres no responde. Comprueba que Postgres está en marcha (`psql -X -d gbrain -c 'select 1'`). launchd lo reintentará cada 10 s.
- **Puerto 3140 ocupado**: `lsof -iTCP:3140 -sTCP:LISTEN` dice qué programa lo usa.
- **Cerrar todas las sesiones** (por ejemplo si alguien más usó este Mac): borra `~/.gbrain-panel/secret` (o `~/.gbrain-panel/sessions.json`) y reinicia el panel; todas las cookies dejan de valer. Para cerrar solo la tuya basta «Cerrar sesión».
- **«No pude leer el registro de Telegram»**: el resto de Hoy sigue funcionando. Suele pasar si el agente de Telegram empezó un archivo nuevo a medias; recarga en un minuto.
- **La búsqueda no encuentra algo con tilde**: los embeddings están apagados, así que la búsqueda de texto completo solo encuentra palabras exactas. La paleta ⌘K sí ignora tildes en títulos y alias.
- **Tras actualizar gbrain o claude**: ejecuta `check.ts`. Si falla algo del chat, el resto del panel sigue funcionando.

## Seguridad, en corto

- Solo escucha en `127.0.0.1:3140`; cualquier otro `Host` recibe 421.
- Inicio de sesión con un código de un solo uso que caduca en 60 s; el secreto viaja por stdin (`curl -H @-`), así que no aparece en `ps`.
- Cada inicio de sesión crea una cookie aleatoria nueva (30 días). El navegador también la envía a otros servicios de `127.0.0.1` (las cookies no distinguen puertos); por eso dura poco y «Cerrar sesión» la anula en el servidor.
- Toda petición que cambia algo necesita la cookie, `Origin: http://127.0.0.1:3140`, la cabecera `X-Panel: 1`, JSON y menos de 64 KB.
- El HTML de las páginas del cerebro se genera en el servidor: el HTML crudo se muestra como texto y solo sobreviven enlaces `http(s)`, `mailto` y los internos.
- La política de contenido (CSP) no permite scripts ni estilos de fuera ni en línea.
- La conexión a Postgres es de solo lectura por defecto, pero el usuario `__USER__` es superusuario: todas las consultas usan parámetros (nunca SQL montado con texto; hay una prueba que lo vigila). Cerrarlo del todo pide un rol solo-SELECT en la base, y eso es decisión tuya.
- El panel nunca abre el token de administración de gbrain, `~/.claude.json` ni los archivos del bot de Telegram, y nunca devuelve los identificadores de chat o de usuario de Telegram.
