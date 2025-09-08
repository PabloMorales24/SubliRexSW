const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');

// Middleware local de autenticación
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login'); // ajusta a '/' si tu login está en la raíz
}

// Utilidad para formatear datetime a input[type=datetime-local]
const toLocalInput = (dt) => {
  if (!dt) return '';
  const d = new Date(dt);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Helpers de inventario
function agruparPorProducto(items) {
  const map = new Map();
  for (const it of (items || [])) {
    const pid = Number(it.producto_id);
    const cant = parseFloat(it.cantidad || 0);
    if (!pid || !cant) continue;
    map.set(pid, (map.get(pid) || 0) + cant);
  }
  return [...map.entries()].map(([product_id, cantidad]) => ({ product_id, cantidad }));
}

async function moverStockYkardex(conn, { bodega_id, items, signo, compraId, usuarioId }) {
  const agregados = agruparPorProducto(items);
  for (const { product_id, cantidad } of agregados) {
    const delta = signo * cantidad;

    // 1) Stock
    await conn.query(`
      INSERT INTO product_stock (product_id, bodega_id, cantidad)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)
    `, [product_id, bodega_id, delta]);

    // 2) Kardex
    await conn.query(`
      INSERT INTO product_inventario
        (product_id, bodega_id, movimiento, cantidad, motivo, referencia, referencia_id, usuario_id)
      VALUES (?, ?, ?, ?, 'COMPRA', 'compras', ?, ?)
    `, [
      product_id,
      bodega_id,
      (signo > 0 ? 'ENTRADA' : 'SALIDA'),
      Math.abs(delta),
      compraId,
      usuarioId
    ]);
  }
}

/* ============ LISTADO ============ */
router.get('/', isAuthenticated, async (req, res) => {
  const { mes, anio } = req.query;
  let sql = `
    SELECT c.*,
           DATE_FORMAT(c.fecha_compra, '%d/%m/%Y %H:%i') AS fecha_formateada,
           p.nombre AS proveedor_nombre,
           b.nombre AS bodega_nombre,
           uc.username AS creador_username,
           um.username AS modificador_username
    FROM compras c
    JOIN proveedores p ON p.id = c.proveedor_id
    JOIN bodegas b     ON b.id = c.bodega_id
    JOIN usuarios uc   ON uc.id = c.usuario_crea_id
    LEFT JOIN usuarios um ON um.id = c.usuario_mod_id
    WHERE 1=1
  `;
  const params = [];
  if (anio) { sql += ' AND YEAR(c.fecha_compra) = ?'; params.push(anio); }
  if (mes)  { sql += ' AND MONTH(c.fecha_compra) = ?'; params.push(mes);  }
  sql += ' ORDER BY c.fecha_compra DESC';

  const [compras] = await pool.query(sql, params);
  res.render('compras_productos/compras_productos_list', { compras, query: { mes, anio } });
});

/* ============ NUEVA ============ */
router.get('/nueva', isAuthenticated, async (req, res) => {
  const [proveedores] = await pool.query('SELECT id, nombre FROM proveedores ORDER BY nombre');
  const [bodegas]     = await pool.query('SELECT id, nombre FROM bodegas ORDER BY nombre');
  const [products]    = await pool.query('SELECT id, nombre FROM products ORDER BY nombre');
  res.render('compras_productos/compras_productos_form', {
    compra: null, proveedores, bodegas, products, detalles: []
  });
});

/* ============ CREAR ============ */
router.post('/', isAuthenticated, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { proveedor_id, bodega_id, fecha_compra, notas } = req.body;
    const itemsObj = req.body.items || {};
    const items = Array.isArray(itemsObj) ? itemsObj : Object.values(itemsObj);

    let total = 0;
    items.forEach(it => total += parseFloat(it.cantidad || 0) * parseFloat(it.precio_unitario || 0));

    const [r] = await conn.query(`
      INSERT INTO compras (proveedor_id, bodega_id, fecha_compra, total, notas, usuario_crea_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [proveedor_id, bodega_id, new Date(fecha_compra), total, (notas || null), req.session.user.id]);

    const compraId = r.insertId;

    for (const it of items) {
      if (!it.producto_id) continue;
      await conn.query(`
        INSERT INTO compras_detalles (compra_id, producto_id, cantidad, precio_unitario)
        VALUES (?, ?, ?, ?)
      `, [compraId, it.producto_id, it.cantidad, it.precio_unitario]);
    }

    await moverStockYkardex(conn, {
      bodega_id: Number(bodega_id),
      items,
      signo: +1,
      compraId,
      usuarioId: req.session.user.id
    });

    await conn.commit();
    res.redirect('/compras-productos/' + compraId);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).send('Error al crear la compra');
  } finally {
    conn.release();
  }
});

/* ============ EDITAR ============ */
router.get('/:id/editar', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const [[compra]] = await pool.query('SELECT * FROM compras WHERE id=?', [id]);
  if (!compra) return res.redirect('/compras-productos');

  const [proveedores] = await pool.query('SELECT id, nombre FROM proveedores ORDER BY nombre');
  const [bodegas]     = await pool.query('SELECT id, nombre FROM bodegas ORDER BY nombre');
  const [products]    = await pool.query('SELECT id, nombre FROM products ORDER BY nombre');
  const [detalles]    = await pool.query('SELECT producto_id, cantidad, precio_unitario FROM compras_detalles WHERE compra_id=?', [id]);

  compra.fecha_compra_local = toLocalInput(compra.fecha_compra);

  res.render('compras_productos/compras_productos_form', {
    compra, proveedores, bodegas, products, detalles
  });
});

/* ============ ACTUALIZAR ============ */
router.post('/:id', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[compraActual]] = await conn.query('SELECT bodega_id FROM compras WHERE id=?', [id]);
    const [detActuales]    = await conn.query('SELECT producto_id, cantidad FROM compras_detalles WHERE compra_id=?', [id]);

    // Revertir stock anterior
    await moverStockYkardex(conn, {
      bodega_id: Number(compraActual.bodega_id),
      items: detActuales,
      signo: -1,
      compraId: Number(id),
      usuarioId: req.session.user.id
    });
    await conn.query(`DELETE FROM product_inventario WHERE referencia='compras' AND motivo='COMPRA' AND referencia_id=?`, [id]);

    const { proveedor_id, bodega_id, fecha_compra, notas } = req.body;
    const itemsObj = req.body.items || {};
    const items = Array.isArray(itemsObj) ? itemsObj : Object.values(itemsObj);

    let total = 0;
    items.forEach(it => total += parseFloat(it.cantidad || 0) * parseFloat(it.precio_unitario || 0));

    await conn.query(`
      UPDATE compras
      SET proveedor_id=?, bodega_id=?, fecha_compra=?, total=?, notas=?, usuario_mod_id=?
      WHERE id=?
    `, [proveedor_id, bodega_id, new Date(fecha_compra), total, (notas || null), req.session.user.id, id]);

    await conn.query('DELETE FROM compras_detalles WHERE compra_id=?', [id]);
    for (const it of items) {
      if (!it.producto_id) continue;
      await conn.query(`
        INSERT INTO compras_detalles (compra_id, producto_id, cantidad, precio_unitario)
        VALUES (?, ?, ?, ?)
      `, [id, it.producto_id, it.cantidad, it.precio_unitario]);
    }

    // Aplicar stock nuevo
    await moverStockYkardex(conn, {
      bodega_id: Number(bodega_id),
      items,
      signo: +1,
      compraId: Number(id),
      usuarioId: req.session.user.id
    });

    await conn.commit();
    res.redirect('/compras-productos/' + id);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).send('Error al actualizar la compra');
  } finally {
    conn.release();
  }
});

/* ============ FICHA ============ */
router.get('/:id', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const [[compra]] = await pool.query(`
    SELECT c.*,
           DATE_FORMAT(c.fecha_compra, '%d/%m/%Y %H:%i') AS fecha_formateada,
           p.nombre AS proveedor_nombre,
           b.nombre AS bodega_nombre,
           uc.username AS creador_username,
           um.username AS modificador_username
    FROM compras c
    JOIN proveedores p ON p.id = c.proveedor_id
    JOIN bodegas b     ON b.id = c.bodega_id
    JOIN usuarios uc   ON uc.id = c.usuario_crea_id
    LEFT JOIN usuarios um ON um.id = c.usuario_mod_id
    WHERE c.id=?
  `, [id]);
  if (!compra) return res.redirect('/compras-productos');

  const [detalles] = await pool.query(`
    SELECT d.*, pr.nombre AS producto_nombre,
           (d.cantidad * d.precio_unitario) AS subtotal
    FROM compras_detalles d
    JOIN products pr ON pr.id = d.producto_id
    WHERE d.compra_id=?
  `, [id]);

  res.render('compras_productos/compras_productos_ficha', { compra, detalles });
});

module.exports = router;
