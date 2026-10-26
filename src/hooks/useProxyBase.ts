import { useQuery } from "@tanstack/react-query";
import { getProxyBase } from "../lib/api";

/** The local proxy's base URL (undefined until the first call resolves). */
export function useProxyBase() {
  return useQuery({ queryKey: ["proxy-base"], queryFn: getProxyBase, staleTime: Infinity }).data;
}
