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
