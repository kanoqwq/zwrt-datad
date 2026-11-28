/* Bounded clear-text NAS QoS state. TS 24.501 8.3.2, 9.11.4.12/14;
 * TS 24.301 default EPS bearer/APN-AMBR. No byte-pattern searching. */
#ifndef U50_NAS_QOS_H
#define U50_NAS_QOS_H
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

struct nq_session {
    int active, pending, pti, qfi, qi, has_ambr;
    uint64_t dl, ul, seq;
    time_t updated, requested;
    char dnn[101];
};
struct nq_state {
    struct nq_session nr[16], eps[16];
    int domain; /* 1=5GS, 2=EPS; NAS domain, not a radio-mode hint */
    uint64_t seq;
};
static struct nq_state Q;

static unsigned nq_be16(const unsigned char *p) { return ((unsigned)p[0] << 8) | p[1]; }
static int nq_dnn(char out[101], const unsigned char *p, size_t n) {
    size_t at=0, used=0;
    if (!n || n>100) return 0;
    while (at<n) {
        unsigned size=p[at++];
        if (!size || size>63 || size>n-at || used+size+(used?1:0)>100) return 0;
        if (used) out[used++]='.';
        for (unsigned j=0;j<size;j++) {
            unsigned c=p[at++];
            if (c>='A' && c<='Z') c+=32;
            if (!((c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='-'||c=='_')) return 0;
            out[used++]=(char)c;
        }
    }
    out[used]=0; return 1;
}
static int nq_ims(const char *dnn) {
    const char *names[]={"ims","sos","emergency","sos-emergency","emergency-service"};
    for (size_t i=0;i<sizeof(names)/sizeof(names[0]);i++) {
        size_t n=strlen(names[i]);
        if (!strncmp(dnn,names[i],n) && (!dnn[n]||dnn[n]=='.')) return 1;
    }
    return 0;
}
static int nq_ambr(struct nq_session *s, const unsigned char *p, size_t n) {
    static const uint64_t units[]={0,1000,4000,16000,64000,256000,1000000,4000000,
        16000000,64000000,256000000,1000000000,4000000000ULL,16000000000ULL,
        64000000000ULL,256000000000ULL};
    if (n!=6 || p[0]<1 || p[0]>15 || p[3]<1 || p[3]>15) return 0;
    s->dl=nq_be16(p+1)*units[p[0]]; s->ul=nq_be16(p+4)*units[p[3]];
    s->has_ambr=1; return 1;
}
static int nq_rules(struct nq_session *s, const unsigned char *p, size_t n) {
    size_t at=0; int found=0, qfi=0;
    while (at<n) {
        if (n-at<4) return 0;
        unsigned size=nq_be16(p+at+1), flags=p[at+3];
        if (size<1 || size>n-at-3) return 0;
        unsigned operation=flags>>5;
        if (operation<1 || operation>6) return 0;
        if ((flags&16) && operation==1) {
            if (size<3) return 0;
            int value=p[at+2+size]&63;
            if (!value || (found && qfi!=value)) return 0;
            found=1; qfi=value;
        }
        at+=3+size;
    }
    if (found) s->qfi=qfi;
    return 1;
}
static int nq_flows(struct nq_session *s, const unsigned char *p, size_t n) {
    size_t at=0;
    while (at<n) {
        if (n-at<3) return 0;
        unsigned qfi=p[at]&63, operation=p[at+1]>>5, count=p[at+2]&63;
        if (!qfi || operation<1 || operation>3) return 0;
        at+=3;
        if (operation==2 && qfi==(unsigned)s->qfi) s->qi=0;
        for (unsigned i=0;i<count;i++) {
            if (n-at<2) return 0;
            unsigned id=p[at++], len=p[at++];
            if (len>n-at) return 0;
            if (id==1 && len==1 && qfi==(unsigned)s->qfi && operation!=2) {
                if (!p[at]) return 0;
                s->qi=p[at];
            }
            at+=len;
        }
    }
    return 1;
}
static void nq_domain(int domain) {
    if (Q.domain && Q.domain!=domain) {
        if (domain==1) memset(Q.eps,0,sizeof(Q.eps));
        else memset(Q.nr,0,sizeof(Q.nr));
    }
    Q.domain=domain;
}
static int nq_nr_optional(struct nq_session *s, const unsigned char *p, size_t n) {
    size_t at=0;
    const unsigned char *flows=NULL; unsigned flow_len=0;
    while (at<n) {
        unsigned ie=p[at++];
        if (ie>=128) continue;
        if (ie==0x59 || ie==0x56) { if (at==n) return 0; at++; continue; }
        int extended=(ie==0x71||ie==0x72||ie==0x74||ie==0x75||ie==0x77||ie==0x78||ie==0x79||ie==0x7a||ie==0x7b);
        if (!extended && !(ie==0x17||ie==0x18||ie==0x1e||ie==0x1f||ie==0x22||ie==0x25||ie==0x29||ie==0x2a||ie==0x66)) break;
        unsigned width=extended?2:1;
        if (width>n-at) return 0;
        unsigned len=extended?nq_be16(p+at):p[at]; at+=width;
        if (len>n-at) return 0;
        const unsigned char *v=p+at;
        if (ie==0x2a && !nq_ambr(s,v,len)) return 0;
        if (ie==0x25 && !nq_dnn(s->dnn,v,len)) return 0;
        if (ie==0x7a && !nq_rules(s,v,len)) return 0;
        /* Optional IEs can arrive in either order: rules select the default
         * QFI before its flow parameters are interpreted. */
        if (ie==0x79) { if (flows) return 0; flows=v; flow_len=len; }
        at+=len;
    }
    return !flows || nq_flows(s,flows,flow_len);
}
static void nq_nr(const unsigned char *p, size_t n, const char *hint) {
    if (n<4 || p[0]!=0x2e || p[1]<1 || p[1]>15 || p[2]==255) return;
    struct nq_session *old=&Q.nr[p[1]], next=*old;
    unsigned mt=p[3]; time_t now=time(NULL);
    if (mt==0xd3 || mt==0xd4 || mt==0xc3) {
        if (mt!=0xd4 && n<5) return;
        memset(old,0,sizeof(*old)); nq_domain(1); return;
    }
    if (mt==0xc1) {
        if (n<6) return;
        if (!old->pending || old->pti!=p[2] || now<old->requested || now-old->requested>120)
            memset(&next,0,sizeof(next));
        next.active=0;
        next.pti=p[2]; next.pending=1; next.requested=now;
        if (hint) snprintf(next.dnn,sizeof(next.dnn),"%s",hint);
        *old=next; nq_domain(1); return;
    }
    if (mt!=0xc2 && mt!=0xcb) return;
    size_t at=4;
    if (mt==0xc2) {
        if (n-at<3 || !(p[at]&7) || (p[at]&7)>5) return;
        at++;
        unsigned rules=nq_be16(p+at); at+=2;
        if (!rules || rules>n-at) return;
        memset(&next,0,sizeof(next)); next.pti=p[2];
        if (old->pti==p[2] && (old->active || (old->pending && now>=old->requested && now-old->requested<=120)))
            snprintf(next.dnn,sizeof(next.dnn),"%s",old->dnn);
        if (!nq_rules(&next,p+at,rules)) return;
        at+=rules;
        if (n-at<7 || p[at]!=6 || !nq_ambr(&next,p+at+1,6)) return;
        at+=7;
    } else if (!old->active) return;
    if (!nq_nr_optional(&next,p+at,n-at)) return;
    next.active=1; next.pending=0; next.updated=now; next.seq=++Q.seq;
    *old=next; nq_domain(1);
}
static int nq_eps_rate(unsigned base, unsigned ext, unsigned ext2, uint64_t *out) {
    uint64_t kbps;
    if (ext==0) {
        if (base>=1 && base<=63) kbps=base;
        else if (base>=64 && base<=127) kbps=64+(base-64)*8;
        else if (base>=128 && base<=254) kbps=576+(base-128)*64;
        else if (base==255) kbps=0;
        else return 0;
    } else if (ext<=74) kbps=8600+ext*100;
    else if (ext<=186) kbps=16000+(ext-74)*1000;
    else if (ext<=250) kbps=128000+(ext-186)*2000;
    else kbps=256000;
    if (ext2>=1 && ext2<=254) kbps+=(uint64_t)ext2*256000;
    *out=kbps*1000; return 1;
}
static int nq_lv(const unsigned char *p, size_t n, size_t *at, const unsigned char **v, unsigned *len) {
    if (*at>=n) return 0;
    *len=p[(*at)++];
    if (*len>n-*at) return 0;
    *v=p+*at; *at+=*len; return 1;
}
static void nq_eps(const unsigned char *p, size_t n, unsigned depth) {
    if (n<2 || depth>2) return;
    if ((p[0]&15)==7) {
        if ((p[0]>>4)!=0) return; /* Never scan encrypted EMM. */
        if (p[1]==0x41 || p[1]==0x45) {
            memset(Q.eps,0,sizeof(Q.eps)); nq_domain(2);
        } else if (p[1]==0x49) nq_domain(2);
        else if (p[1]==0x42) {
            if (n<7) return;
            size_t at=5+p[4];
            if (p[4]<6 || at>n || n-at<2) return;
            unsigned len=nq_be16(p+at); at+=2;
            if (len>n-at) return;
            nq_domain(2); nq_eps(p+at,len,depth+1);
        }
        return;
    }
    if (n<3 || (p[0]&15)!=2) return;
    unsigned id=p[0]>>4, mt=p[2];
    if (id<5 || id>15) return;
    struct nq_session *old=&Q.eps[id], next=*old;
    if (mt==0xcd || mt==0xce) { memset(old,0,sizeof(*old)); nq_domain(2); return; }
    if (mt!=0xc1 && mt!=0xc9) return; /* Dedicated bearers never replace default QoS. */
    size_t at=3; const unsigned char *v; unsigned len;
    if (mt==0xc1) {
        memset(&next,0,sizeof(next));
        if (!nq_lv(p,n,&at,&v,&len) || !len || !v[0]) return;
        next.qi=v[0];
        if (!nq_lv(p,n,&at,&v,&len) || !nq_dnn(next.dnn,v,len)) return;
        if (!nq_lv(p,n,&at,&v,&len) || !len) return;
    } else if (!old->active) return;
    while (at<n) {
        unsigned ie=p[at++]; if (ie>=128) continue;
        if (ie==0x32 || ie==0x58) { if (at==n) return; at++; continue; }
        if (ie==0x7b) {
            if (n-at<2) return;
            len=nq_be16(p+at); at+=2; if (len>n-at) return; at+=len; continue;
        }
        if (!(ie==0x5e||ie==0x27||ie==0x30||ie==0x5d||ie==0x34||ie==0x36||ie==0x33||ie==0x66||ie==0x6e||ie==0x5f||ie==0x5b||ie==0x5c)) break;
        if (!nq_lv(p,n,&at,&v,&len)) return;
        if (ie==0x5e) {
            if (!(len==2||len==4||len==6)) return;
            if (!nq_eps_rate(v[0],len>=4?v[2]:0,len==6?v[4]:0,&next.dl) ||
                !nq_eps_rate(v[1],len>=4?v[3]:0,len==6?v[5]:0,&next.ul)) return;
            next.has_ambr=1;
        }
        if (ie==0x5b && mt==0xc9 && len && v[0]) next.qi=v[0];
    }
    next.active=1; next.pti=p[1]; next.seq=++Q.seq; next.updated=time(NULL);
    *old=next; nq_domain(2);
}
static void nq_nas(const unsigned char *p, size_t n) {
    if (!n) return;
    if (p[0]==0x2e) { nq_nr(p,n,NULL); return; }
    if (p[0]!=0x7e) { nq_eps(p,n,0); return; }
    if (n<3 || p[1]!=0) return;
    unsigned mt=p[2];
    if (mt==0x41 && n>=4 && ((p[3]&7)==1 || (p[3]&7)==4)) {
        memset(Q.nr,0,sizeof(Q.nr)); nq_domain(1); return;
    }
    if (mt==0x45 || mt==0x47) { memset(Q.nr,0,sizeof(Q.nr)); nq_domain(1); return; }
    if (mt==0x42) { nq_domain(1); return; }
    if (mt!=0x67 && mt!=0x68) return;
    if (n<6 || (p[3]&15)!=1) return;
    unsigned len=nq_be16(p+4); size_t at=6;
    if (len<4 || len>n-at || p[at]!=0x2e) return;
    const unsigned char *inner=p+at; at+=len;
    int id=0; char hint[101]={0};
    while (at<n) {
        unsigned ie=p[at++]; if (ie>=128) continue;
        if (ie==0x12||ie==0x59||ie==0x58) { if (at==n) return; if (ie==0x12) id=p[at]; at++; continue; }
        if (!(ie==0x22||ie==0x25||ie==0x24||ie==0x37||ie==0x3a)) break;
        const unsigned char *v; unsigned size;
        if (!nq_lv(p,n,&at,&v,&size)) return;
        if (ie==0x25 && !nq_dnn(hint,v,size)) return;
    }
    nq_nr(inner,len,mt==0x67 && inner[3]==0xc1 && (!id || id==inner[1]) && hint[0]?hint:NULL);
}
static void nq_packet(unsigned code, const unsigned char *p, size_t n) {
    static const unsigned char nr_header[]={1,0,0,0,15,4,0};
    if (code==0xb800||code==0xb801||code==0xb80a||code==0xb80b) {
        if (n>sizeof(nr_header) && !memcmp(p,nr_header,sizeof(nr_header))) nq_nas(p+7,n-7);
    } else if (code==0xb0e2||code==0xb0e3||code==0xb0ec||code==0xb0ed) {
        if (n>=6 && p[0]==1 && !p[1] && !p[2] && !p[3]) nq_eps(p+4,n-4,0);
    }
}
static void nq_write(FILE *f) {
    fprintf(f,",\"qos_version\":1,\"qos_domain\":\"%s\",\"qos_sessions\":[",Q.domain==1?"5gs":Q.domain==2?"eps":"unknown");
    int first=1;
    for (int domain=1;domain<=2;domain++) for (int id=1;id<16;id++) {
        const struct nq_session *s=domain==1?&Q.nr[id]:&Q.eps[id];
        if (!s->active) continue;
        fprintf(f,"%s{\"domain\":\"%s\",\"id\":%d,\"pti\":%d,\"qci\":%d,\"apn\":\"%s\",\"sampled_at\":%lld,\"seq\":%llu",
            first?"":",",domain==1?"5gs":"eps",id,s->pti,s->qi,s->dnn,(long long)s->updated,(unsigned long long)s->seq);
        if (s->has_ambr) fprintf(f,",\"ambr_dl_bps\":%llu,\"ambr_ul_bps\":%llu",(unsigned long long)s->dl,(unsigned long long)s->ul);
        fprintf(f,"}"); first=0;
    }
    fprintf(f,"]");
    /* Keep the legacy 5QI diagnostic list, but never derive it by a byte scan. */
    if (Q.domain==1) {
        int qi_first=1;
        for (int id=1;id<16;id++) if (Q.nr[id].active && Q.nr[id].qi && Q.nr[id].dnn[0] && !nq_ims(Q.nr[id].dnn)) {
            fprintf(f,"%s%d",qi_first?",\"five_qi\":[":",",Q.nr[id].qi); qi_first=0;
        }
        if (!qi_first) fprintf(f,"]");
    }
}
#endif
