# Hashline edit

Plugin para opencode v2 que sirve archivos con anchors estables para editar por referencia en vez de por número de línea.

## Language

**Anchor**:
Identificador corto alocado por línea servida, nunca derivado de su contenido.
_Avoid_: número de línea, hash derivado, hash de contenido

**Served-record**:
Registro de qué anchors se sirvieron, a quién y sobre qué estado del archivo; es lo que verifica cada edit.
_Avoid_: caché

**Ownership**:
Vínculo de un anchor con la sesión y el archivo que lo recibieron; fuera de ese contexto no es válido.
_Avoid_: anchor global, anchor compartido

**Sidecar**:
Base SQLite por proyecto y sesión que persiste alocación, served-record y sombras de undo.
_Avoid_: base del plugin, store genérico

**Batch**:
Edits del mismo mensaje al mismo archivo que commitean una vez con un solo undo.
_Avoid_: transacción, lote

**Echo**:
Prefijo `anchor│` que el modelo pega al invocar una tool nativa con texto leído.
_Avoid_: prefijo, hash pegado

**Undo por archivo**:
Restauración de un archivo a su estado previo al último batch, de un solo nivel y persistente entre restarts.
_Avoid_: historial, undo global

**Match**:
Ocurrencia de texto servido que `replace_match` sustituye por otro.
_Avoid_: regex, búsqueda libre

**Copy**:
Edit que replica líneas servidas a un destino ya servido, sin heredar served-record.
_Avoid_: duplicar, clonar

**Move**:
Copy cuyo origen se vacía solo cuando el destino ya commiteó.
_Avoid_: renombrar, mover atómico

**Grep de anchors**:
Búsqueda que solo devuelve anchors ya servidos, sin servir nada nuevo.
_Avoid_: grep de texto, búsqueda global

**Auto-read**:
Servido automático de archivos referenciados en el mensaje; con sidecar por sesión, re-servir lo de otra sesión es válido y solo frena la Cuota sin reclamar.
_Avoid_: rastreo, precarga

**Gate**:
Criterio que deja pasar o frena un auto-servido, siempre con nota motivada.
_Avoid_: permiso, filtro

**Cuota**:
Margen libre bajo `maxAnchors`; el auto-read solo sirve si hay margen, nunca reclama.
_Avoid_: límite, tope
