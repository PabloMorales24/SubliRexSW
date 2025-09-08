const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET /products/nuevo
router.get('/nuevo', (_req, res) => {
  res.render('products/form', { title: 'Nuevo producto' });
});

// POST /products/nuevo
router.post('/nuevo', async (req, res, next) => {
  try {
    const {
      nombre, descripcion, precio_compra, precio_venta,
      imagen, brand_id, material_id, color_id, shape_id, unit_id, capacidad
    } = req.body;

    await pool.query(`
      INSERT INTO products
        (nombre, descripcion, precio_compra, precio_venta, imagen, brand_id, material_id, color_id, shape_id, unit_id, capacidad)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [nombre, descripcion || null, precio_compra, precio_venta, imagen || null,
        brand_id || null, material_id || null, color_id || null, shape_id || null, unit_id || null, capacidad || null]);

    res.redirect('/informacion');
  } catch (e) { next(e); }
});

module.exports = router;
