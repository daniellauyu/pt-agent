# 守护进程零第三方依赖，镜像里只要 Node 运行时和源码。
FROM node:25-alpine

# 用非 root 跑：这个进程能删下载器里的文件，没有任何理由让它以 root 身份运行。
# node 镜像自带 uid/gid 1000 的 node 用户。
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node src/ ./src/
COPY --chown=node:node vendor/ ./vendor/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node .env.example ./

# 配置和日志全在这一个卷里，挂出来就能在宿主机上编辑 .env、看日志。
ENV PTAGENT_HOME=/data
VOLUME ["/data"]
EXPOSE 7788

USER node

# 健康检查打的是 WebUI 的状态接口——它能返回就说明进程活着且配置读得出来。
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const t=process.env.PTAGENT_WEB_TOKEN||'';fetch('http://127.0.0.1:'+(process.env.PTAGENT_WEB_PORT||7788)+'/api/status',{headers:t?{Authorization:'Bearer '+t}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 容器里 WebUI 必须绑 0.0.0.0，否则宿主机映射了端口也进不去。
# 绑非回环地址时守护进程会强制要求访问令牌，所以 compose 里一定要给 PTAGENT_WEB_TOKEN。
ENV PTAGENT_WEB_HOST=0.0.0.0

ENTRYPOINT ["node", "bin/ptagent.js"]
CMD ["start"]
