"""Killable one-request worker; credentials travel only through a private pipe."""
from __future__ import annotations
from dataclasses import asdict
import json
import os
import subprocess
import sys
from .model_client import ModelClient


def bounded_chat(client, settings, system, user, max_tokens, timeout_seconds=60):
    if not isinstance(client, ModelClient):
        return client.chat(settings.model,system,user,max_tokens=max_tokens)
    env=dict(os.environ)
    env['PYTHONPATH']=os.pathsep.join(sys.path)
    env['PYTHONUTF8']='1'
    packet={'settings':asdict(settings),'system':system,'user':user,'max_tokens':max_tokens}
    routes=settings.model.route_chain
    route_index=getattr(client,'_bounded_route_index',0)%len(routes)
    route=routes[route_index]
    packet['settings']['models'][0].update(base_url=route.base_url,api_key=route.api_key,backup_routes=[])
    try:
        result=subprocess.run([sys.executable,'-m','nexiom_visualization.bounded_request'],
            input=json.dumps(packet,ensure_ascii=False,default=str).encode('utf-8'),capture_output=True,
            timeout=timeout_seconds,env=env)
    except subprocess.TimeoutExpired as exc:
        client._bounded_route_index=(route_index+1)%len(routes)
        raise TimeoutError(f'单次模型请求超过{timeout_seconds}秒，工作进程已终止；服务端可能仍计费。') from exc
    if result.returncode:
        raise RuntimeError('模型工作进程失败：'+result.stderr.decode('utf-8',errors='replace')[-500:])
    response=json.loads(result.stdout)
    if response.get('error'):
        client._bounded_route_index=(route_index+1)%len(routes)
        raise RuntimeError(response['error'])
    return response


def main():
    from dataclasses import replace
    from pathlib import Path
    from .config import Settings,ModelConfig,RouteConfig
    packet=json.load(sys.stdin); raw=packet['settings']
    models=[]
    for model in raw['models']:
        model['backup_routes']=tuple(RouteConfig(**r) for r in model.get('backup_routes',[]))
        models.append(ModelConfig(**model))
    raw['models']=tuple(models)
    for key in ('project_root','runs_dir'): raw[key]=Path(raw[key])
    settings=replace(Settings(**raw),retry_attempts=1,timeout_seconds=60)
    try:
        response=ModelClient(settings).chat(settings.model,packet['system'],packet['user'],max_tokens=packet['max_tokens'])
        json.dump({k:v for k,v in response.items() if k!='raw'},sys.stdout,ensure_ascii=False)
    except Exception as exc:
        # Do not print settings, payload, credentials, or provider response bodies.
        chain=[]; current=exc
        while current is not None and len(chain)<4:
            status=getattr(current,'code',None) or getattr(current,'status_code',None)
            chain.append(type(current).__name__+(f' HTTP {status}' if isinstance(status,int) else ''))
            current=current.__cause__
        json.dump({'error':' → '.join(chain)+': 单次传输失败，检查配置或重试。'},sys.stdout,ensure_ascii=False)


if __name__=='__main__': main()
