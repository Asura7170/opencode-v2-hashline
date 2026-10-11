# Auto-read nunca roba ownership ni reclama LRU

El auto-servido solo usa holgura bajo `maxAnchors` y solo sobre archivos sin dueño ajeno: lo ajeno se salta con nota y la cuota llena frena en vez de reclamar, porque el contexto servido por el usuario es intocable y reclamarlo por lecturas de fondo lo degradaría en silencio. La alternativa (reclamar como un `read` más) se rechazó por ese costo invisible.
