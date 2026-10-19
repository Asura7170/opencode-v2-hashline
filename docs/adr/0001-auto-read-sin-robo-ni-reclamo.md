# Auto-read nunca roba ownership ni reclama LRU

El auto-servido solo usa holgura bajo `maxAnchors` y la cuota llena frena en vez de reclamar, porque el contexto servido por el usuario es intocable y reclamarlo por lecturas de fondo lo degradaría en silencio. La alternativa (reclamar como un `read` más) se rechazó por ese costo invisible.

Los sidecars son por sesión (fase 1): cada sesión lleva su pool de anchors y su served-record, así que re-servir un archivo ya servido por otra sesión es válido y no roba nada — no existe registro compartido que robar. La guarda de "dueño ajeno" del Gate vivía solo bajo una geometría de store compartido que nunca ocurre en producción (código muerto sin efecto) y se eliminó tras el test IDE de la fase 3; la regla viva del Gate que sobrevive es la Cuota.
