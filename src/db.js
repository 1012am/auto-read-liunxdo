// PostgreSQL 数据库工具
import fs from "fs";

import pkg from 'pg';
const { Pool } = pkg;
import dotenv from "dotenv";
dotenv.config();
if (fs.existsSync(".env.local")) {
  console.log("Using .env.local file to supply config environment variables");
  const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else {
  console.log(
    "Using .env file to supply config environment variables, you can create a .env.local file to overwrite defaults, it doesn't upload to git"
  );
}
// 主数据库连接池 (Aiven PostgreSQL)
const pool = new Pool({
  connectionString: process.env.POSTGRES_URI,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: { rejectUnauthorized: false }
});

// 备用数据库连接池 (CockroachDB)
const cockroachPool = new Pool({
  connectionString: process.env.COCKROACH_URI,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: { rejectUnauthorized: false }
});

// 备用数据库连接池 (Neon)
const neonPool = new Pool({
  connectionString: process.env.NEON_URI,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: { rejectUnauthorized: false }
});

// 所有数据库连接池数组
const allPools = [
  { name: 'Aiven PostgreSQL', pool: pool },
  { name: 'CockroachDB', pool: cockroachPool },
  { name: 'Neon', pool: neonPool }
];

export async function savePosts(posts) {
  if (!Array.isArray(posts) || posts.length === 0) return;
  
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT,
      creator TEXT,
      description TEXT,
      link TEXT,
      pubDate TEXT,
      guid TEXT UNIQUE,
      guidIsPermaLink TEXT,
      source TEXT,
      sourceUrl TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  
  const insertQuery = `
    INSERT INTO posts (title, creator, description, link, pubDate, guid, guidIsPermaLink, source, sourceUrl)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (guid) DO NOTHING
  `;

  // 并行操作所有数据库
  const savePromises = allPools.map(async ({ name, pool: dbPool }) => {
    try {
      console.log(`正在保存到 ${name}...`);
      
      // 建表
      await dbPool.query(createTableQuery);
      
      // 插入数据
      for (const post of posts) {
        await dbPool.query(insertQuery, [
          post.title,
          post.creator,
          post.description,
          post.link,
          post.pubDate,
          post.guid,
          post.guidIsPermaLink,
          post.source,
          post.sourceUrl
        ]);
      }
      
      console.log(`✅ ${name} 保存成功 (${posts.length} 条记录)`);
      return { name, success: true };
    } catch (error) {
      console.error(`❌ ${name} 保存失败:`, error.message);
      return { name, success: false, error: error.message };
    }
  });

  // 等待所有数据库操作完成
  const results = await Promise.allSettled(savePromises);
  
  // 统计结果
  const successCount = results.filter(result => 
    result.status === 'fulfilled' && result.value.success
  ).length;
  
  console.log(`数据库保存结果: ${successCount}/${allPools.length} 个数据库保存成功`);
  
  // 如果至少有一个数据库保存成功，就认为操作成功
  if (successCount === 0) {
    throw new Error('所有数据库保存都失败了');
  }
}

export async function isGuidExists(guid) {
  // 优先查询主数据库 (Aiven PostgreSQL)
  try {
    const res = await pool.query("SELECT 1 FROM posts WHERE guid = $1 LIMIT 1", [
      guid,
    ]);
    // console.log("isGuidExists查询结果:", res.rows); 存在的返回[ { '?column?': 1 } ]
    if (res.rowCount > 0) {
      return true;
    }
  } catch (error) {
    console.warn(`主数据库查询GUID失败: ${error.message}`);
  }

  // 如果主数据库查询失败或未找到，尝试查询备用数据库
  for (const { name, pool: dbPool } of allPools.slice(1)) { // 跳过主数据库
    try {
      const res = await dbPool.query("SELECT 1 FROM posts WHERE guid = $1 LIMIT 1", [
        guid,
      ]);
      if (res.rowCount > 0) {
        console.log(`在备用数据库 ${name} 中找到GUID: ${guid}`);
        return true;
      }
    } catch (error) {
      console.warn(`备用数据库 ${name} 查询GUID失败: ${error.message}`);
    }
  }

  return false;
}

// 测试所有数据库连接
export async function testAllConnections() {
  console.log('正在测试所有数据库连接...');
  
  const testPromises = allPools.map(async ({ name, pool: dbPool }) => {
    try {
      await dbPool.query('SELECT 1');
      console.log(`✅ ${name} 连接正常`);
      return { name, connected: true };
    } catch (error) {
      console.error(`❌ ${name} 连接失败:`, error.message);
      return { name, connected: false, error: error.message };
    }
  });

  const results = await Promise.allSettled(testPromises);
  const connectedCount = results.filter(result => 
    result.status === 'fulfilled' && result.value.connected
  ).length;
  
  console.log(`数据库连接测试结果: ${connectedCount}/${allPools.length} 个数据库连接正常`);
  return results;
}

// 获取所有数据库的统计信息
export async function getAllDatabaseStats() {
  console.log('正在获取所有数据库统计信息...');
  
  const statsPromises = allPools.map(async ({ name, pool: dbPool }) => {
    try {
      const countResult = await dbPool.query('SELECT COUNT(*) as count FROM posts');
      const latestResult = await dbPool.query('SELECT created_at FROM posts ORDER BY created_at DESC LIMIT 1');
      
      const stats = {
        name,
        totalPosts: parseInt(countResult.rows[0].count),
        latestPost: latestResult.rows[0]?.created_at || null,
        status: 'healthy'
      };
      
      console.log(`📊 ${name}: ${stats.totalPosts} 条记录`);
      return stats;
    } catch (error) {
      console.error(`❌ ${name} 统计信息获取失败:`, error.message);
      return {
        name,
        totalPosts: -1,
        latestPost: null,
        status: 'error',
        error: error.message
      };
    }
  });

  const results = await Promise.allSettled(statsPromises);
  return results.map(result => 
    result.status === 'fulfilled' ? result.value : result.reason
  );
}

// 关闭所有数据库连接
export async function closeAllConnections() {
  console.log('正在关闭所有数据库连接...');
  
  const closePromises = allPools.map(async ({ name, pool: dbPool }) => {
    try {
      await dbPool.end();
      console.log(`✅ ${name} 连接已关闭`);
    } catch (error) {
      console.error(`❌ ${name} 连接关闭失败:`, error.message);
    }
  });

  await Promise.allSettled(closePromises);
  console.log('所有数据库连接关闭完成');
}
