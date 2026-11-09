# Nauta Live TV — plugin de Kino

Canales de TV en vivo de **Argentina**, deportes, películas 24/7, infantiles, noticias y más.

## Instalar

En Kino: **Ajustes ▸ Plugins ▸ Agregar**, y escribe `xuper-plugin/kino-plugin-nauta`. Kino muestra la hoja de consentimiento (a qué hosts llega y qué permisos pide) antes de instalar nada.

## Qué trae

- **En vivo** (pestaña *En vivo* de Kino) y una fila en el Inicio con las listas que respondan primero (más vistos, nacionales, HD).
- La lista de canales se guarda 6 horas: si la actualización falla, se sigue mostrando la copia anterior.
- Los canales salen de un addon de Stremio (`stremio-addon-wheat.vercel.app`) y de listas en `m3u.cl`; el video puede venir de otros servidores (`liveStreamHosts: any`, aviso en rojo al instalar).

## Ajustes

- **Estado de la caché** y la acción **Actualizar lista de canales**.

## Licencia

Apache-2.0 (ver `LICENSE`). El plugin no aloja ni almacena contenido: muestra lo que devuelve el servicio indicado arriba, y lo que se ve a través de él
es responsabilidad de quien lo usa. No está afiliado con los servicios ni con los sitios que menciona.
