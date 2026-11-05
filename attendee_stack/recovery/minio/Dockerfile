# Exact official MinIO release package; extract only, never run maintainer scripts.
FROM public.ecr.aws/docker/library/ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956 AS package
COPY minio.deb /tmp/minio.deb
RUN echo "d8898351831761e083e7ba6b74ea7ec478b9a6680794fe92e5e838145341c9c5  /tmp/minio.deb" | sha256sum --check --strict - \
    && dpkg-deb --extract /tmp/minio.deb /release \
    && test -x /release/usr/local/bin/minio

FROM public.ecr.aws/docker/library/ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956
COPY --from=package /release/usr/local/bin/minio /usr/local/bin/minio
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
