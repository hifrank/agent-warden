import * as k8s from "@kubernetes/client-node";

let _kubeConfig: k8s.KubeConfig | undefined;

export function getK8sClients() {
  if (!_kubeConfig) {
    _kubeConfig = new k8s.KubeConfig();
    _kubeConfig.loadFromDefault(); // In-cluster or kubeconfig
  }

  return {
    core: _kubeConfig.makeApiClient(k8s.CoreV1Api),
    apps: _kubeConfig.makeApiClient(k8s.AppsV1Api),
    custom: _kubeConfig.makeApiClient(k8s.CustomObjectsApi),
    exec: new k8s.Exec(_kubeConfig),
  };
}
