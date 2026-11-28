import React,{useMemo} from 'react';
import {Box,Text} from '@mantine/core';
import {vendorSimilarity} from '../sigweb/vendor-similarity.js';

export function VendorReference({evidence,retained=false}) {
  const result=useMemo(()=>vendorSimilarity(evidence),[evidence]);
  const groupName=key=>({query:'能力查询',dedicated:'专用 PUCCH',broadcast:'LTE SIB2','nr-broadcast':'NR SIB1'})[key];
  return <Box className="signal-vendor-reference" data-testid="vendor-reference">
    <Text fz={11} fw={600}>推断参考 · 样例相似度</Text>
    {result.available?<>
      <ul>{result.rows.map(row=><li key={row.id}>
        <span>{row.name}</span><strong>{row.score===null?'—':`${row.score}%`}</strong>
        <span>{row.score===null?'证据不足':<>{row.groups.map(g=>`${groupName(g.key)} ${Math.round(g.fraction*100)}%`).join(' · ')}
          <small>{row.groups.length} 组证据 · {row.comparisonCount} 项可比</small></>}</span>
      </li>)}</ul>
      <details><summary>查看计算依据</summary>
        <p>频段取交集 / 并集；同一厂商有多个频段样例时取最接近的一组，其他项比较实际值或请求是否携带。先对每组内项目求均值，再对可用证据组等权平均。缺省数值不参与比较，重复消息不加票；NR SIB1 的 IMS 标记仅按用户提供的大唐规则单列参考，不使用 P0、参考功率或另一制式的结果。</p>
        {result.rows.filter(row=>row.score!==null).map(row=><div key={row.id}>
          <b>{row.name}</b>{row.groups.map(g=><p key={g.key}>{groupName(g.key)}：{g.items.map(item=>item.zh).join('；')}</p>)}
          {row.weakDelta&&<p>中兴 PUCCH 数值来自教程文字观察，未经独立抓包标注；仅用于此处参考。</p>}
        </div>)}
      </details>
    </>:<p>暂不可推断：等待同小区可用的 NR SIB1、能力查询、专用 PUCCH 配置或 LTE SIB2。</p>}
    {retained&&<p>基于同一服务小区最近一次匹配记录。</p>}
    <p>百分比仅比较已观测字段与现有样例，不是厂商真实概率，各家无需合计 100%。未建模厂商不参与排名。{evidence?.radio==='LTE'?'大唐现场规则仅用于 NR，不根据 LTE B39 判厂商。':''}</p>
  </Box>;
}
