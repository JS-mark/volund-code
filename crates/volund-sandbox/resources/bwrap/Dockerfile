FROM debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash=5.2.15-2+b13 \
       gcc=4:12.2.0-3 \
       gcc-12=12.2.0-14+deb12u1 \
       libc6-dev=2.36-9+deb12u14 \
       libcap-dev=1:2.66-4+deb12u3+b1 \
       binutils=2.40-2 \
    && rm -rf /var/lib/apt/lists/*
COPY . /src
RUN /src/build.sh /src/source /bwrap
